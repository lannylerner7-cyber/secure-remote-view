using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json.Serialization;



using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Thin HTTP client for the ConnectLive gateway.
/// Routes (kept in sync with src/shared/api-routes.ts):
///   POST /api/public/agent/enroll               -> { deviceId, deviceToken }  (keyless, IP-throttled)
///   POST /api/public/agent/hello                -> presence "arrived" signal
///   POST /api/public/agent/heartbeat            -> pending session invites + is_session_active
///   POST /api/public/agent/session/:id/reconnect -> resume same device/session after reboot
///   POST /api/public/agent/session/:id/consent   -> user consent result
///   POST /api/public/agent/session/:id/frame     -> JPEG screen frame
///   POST /api/public/agent/session/:id/cursor    -> cursor telemetry
///   GET  /api/public/agent/session/:id/inputs    -> admin input queue (long-poll)
///   POST /api/public/agent/session/:id/signal    -> WebRTC signaling
///   GET  /api/public/agent/session/:id/signal    -> WebRTC signaling (poll)
/// All authenticated requests send X-Device-Id + X-Device-Token.
/// Transport is HTTPS-only; the old realtime WebSocket path was removed
/// (heartbeat + long-poll already deliver invites and signaling).
/// </summary>
public sealed class ApiClient
{
    // Override at build time or via first-run --api-url flag.
    public const string DefaultApiBaseUrl = "https://zoomlite.live";

    // Hidden per-user store. LOCALAPPDATA (not ProgramData) so DPAPI
    // CurrentUser/LocalMachine both work without elevation, and the folder is
    // marked Hidden|System so it isn't casually deleted by the end user.
    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ConnectLive");
    private static readonly string LegacyConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ConnectLive");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");
    private static readonly string DevicePath = Path.Combine(ConfigDir, "device.dat");
    private static readonly string SessionPath = Path.Combine(ConfigDir, "session.dat");

    private readonly HttpClient _http;
    public string ApiBaseUrl { get; }
    public string? DeviceId { get; private set; }
    public string? DeviceToken { get; private set; }

    // Single-flight re-enroll guard. On a burst of concurrent 401s (heartbeat,
    // frame, cursor, input, signal loops all firing at once), only one thread
    // wipes device.dat and calls the enroll endpoint; the others park on this
    // semaphore, notice the token generation moved, and retry with the fresh
    // credential instead of enrolling a second time.
    private static readonly SemaphoreSlim _enrollLock = new(1, 1);
    private long _tokenGeneration;
    // If a re-enroll itself 401s (deployment key revoked), stop hammering the
    // gateway. Set to now + 60s; SendAuthedAsync short-circuits until it passes.
    private DateTime _revokedUntilUtc = DateTime.MinValue;

    /// <summary>Fired once when the deployment key appears to be revoked.
    /// Wired to a tray balloon from App.xaml.cs so the technician sees a
    /// single "reinstall required" toast instead of an exception dialog.</summary>
    public event Action<string>? OnEnrollmentRevoked;

    public ApiClient(string? overrideBaseUrl = null)
    {
        Directory.CreateDirectory(ConfigDir);
        HideStore();
        MigrateLegacyStore();
        ApiBaseUrl = overrideBaseUrl ?? LoadConfig()?.ApiBaseUrl ?? DefaultApiBaseUrl;
        _http = new HttpClient { BaseAddress = new Uri(ApiBaseUrl), Timeout = TimeSpan.FromSeconds(20) };
        LoadDeviceCreds();
    }

    /// <summary>Marks the store folder Hidden|System so it survives casual cleanup.</summary>
    private static void HideStore()
    {
        try
        {
            var di = new DirectoryInfo(ConfigDir);
            di.Attributes |= FileAttributes.Hidden | FileAttributes.System;
        }
        catch { }
    }

    private static void MarkHidden(string path)
    {
        try
        {
            File.SetAttributes(path,
                FileAttributes.Hidden | FileAttributes.System | FileAttributes.NotContentIndexed);
        }
        catch { }
    }

    /// <summary>Writes an encrypted blob to a Hidden|System file. Windows
    /// refuses a plain overwrite of a hidden file, so attributes are cleared
    /// first and re-applied after the write.</summary>
    private static void WriteHidden(string path, byte[] data)
    {
        try { if (File.Exists(path)) File.SetAttributes(path, FileAttributes.Normal); } catch { }
        File.WriteAllBytes(path, data);
        MarkHidden(path);
    }

    /// <summary>One-time move of device/session/config from %ProgramData% to
    /// %LOCALAPPDATA%. Credentials are re-used verbatim — no re-enrollment.</summary>
    private static void MigrateLegacyStore()
    {
        try
        {
            if (!Directory.Exists(LegacyConfigDir)) return;
            foreach (var name in new[] { "device.dat", "session.dat", "config.json" })
            {
                var oldPath = Path.Combine(LegacyConfigDir, name);
                var newPath = Path.Combine(ConfigDir, name);
                if (!File.Exists(oldPath) || File.Exists(newPath)) continue;
                File.Copy(oldPath, newPath);
                if (name != "config.json") MarkHidden(newPath);
                try { File.Delete(oldPath); } catch { }
            }
        }
        catch { }
    }

    private void AddAuth(HttpRequestMessage req)
    {
        req.Headers.Add("X-Device-Id", DeviceId!);
        req.Headers.Add("X-Device-Token", DeviceToken!);
    }

    // ---- Enrollment ----------------------------------------------------

    public async Task EnrollIfNeededAsync(CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(DeviceToken)) return;

        // Deployment-key-free enrollment: the server mints a random per-device
        // token and stores only its SHA-256 hash. We just POST identifying
        // metadata; DPAPI-encrypt the returned token into device.dat.
        var payload = new
        {
            hostname = Environment.MachineName,
            os = Environment.OSVersion.VersionString,
            displayName = Environment.MachineName,
            agentVersion = typeof(ApiClient).Assembly.GetName().Version?.ToString() ?? "1.0.0"
        };
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/enroll")
        {
            Content = JsonContent.Create(payload),
        };
        using var resp = await _http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadFromJsonAsync<EnrollResponse>(cancellationToken: ct)
                   ?? throw new InvalidOperationException("Empty enrollment response");

        DeviceId = body.DeviceId;
        DeviceToken = body.DeviceToken;
        SaveDeviceCreds(body);
        Interlocked.Increment(ref _tokenGeneration);
    }


    // Runs a request, and on a single 401 wipes local creds + re-enrolls (once,
    // guarded by _enrollLock so parallel loops don't stampede), then retries.
    // A second 401 marks the deployment key as revoked and backs off 60s.
    // Callers must not dispose the returned response before consuming it.
    private async Task<HttpResponseMessage> SendAuthedAsync(Func<HttpRequestMessage> build, CancellationToken ct)
    {
        if (DateTime.UtcNow < _revokedUntilUtc)
            throw new HttpRequestException("Enrollment revoked; waiting for cooldown");

        var beforeGen = Interlocked.Read(ref _tokenGeneration);
        var req = build();
        AddAuth(req);
        var resp = await _http.SendAsync(req, ct);
        if (resp.StatusCode != System.Net.HttpStatusCode.Unauthorized) return resp;
        resp.Dispose();
        req.Dispose();

        // Single-flight re-enroll.
        await _enrollLock.WaitAsync(ct);
        try
        {
            if (Interlocked.Read(ref _tokenGeneration) == beforeGen)
            {
                // Nobody else re-enrolled yet — we do it.
                try
                {
                    if (File.Exists(DevicePath)) File.Delete(DevicePath);
                }
                catch { /* best-effort */ }
                DeviceId = null;
                DeviceToken = null;
                try { await EnrollIfNeededAsync(ct); }
                catch (HttpRequestException) { throw; }
                catch (Exception ex) { throw new HttpRequestException("Re-enrollment failed: " + ex.Message); }
            }
        }
        finally { _enrollLock.Release(); }

        // Retry once with the fresh token.
        var req2 = build();
        AddAuth(req2);
        var resp2 = await _http.SendAsync(req2, ct);
        req2.Dispose();
        if (resp2.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            resp2.Dispose();
            _revokedUntilUtc = DateTime.UtcNow.AddSeconds(60);
            try { OnEnrollmentRevoked?.Invoke("Enrollment revoked — reinstall required."); } catch { }
            throw new HttpRequestException("Enrollment revoked after retry");
        }
        return resp2;
    }

    public async Task HelloAsync(CancellationToken ct)
    {
        using var resp = await SendAuthedAsync(
            () => new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/hello"), ct);
        resp.EnsureSuccessStatusCode();
    }

    public async Task<string> HeartbeatAsync(CancellationToken ct)
    {
        // Best-effort LAN fingerprint so admins can pick a peer for WoL.
        var (subnet, mac, ipv4) = PowerRelay.LocalLanFingerprint();
        var payload = new { lan = new { subnet_v4 = subnet, mac, ipv4 } };
        using var resp = await SendAuthedAsync(() => new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/heartbeat")
        {
            Content = JsonContent.Create(payload),
        }, ct);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadAsStringAsync(ct);
    }

    // ---- Power commands (WoL relay + local actions) --------------------

    public async Task AckPowerCommandAsync(string cmdId, string state, string? error, CancellationToken ct)
    {
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/power/{cmdId}/ack")
                {
                    Content = JsonContent.Create(new { state, error }),
                }, ct);
        }
        catch { /* best-effort */ }
    }

    public async Task SubmitConsentAsync(string sessionId, bool accepted, CancellationToken ct)
    {
        // Server expects { decision: "accept" | "decline" } — see
        // src/routes/api/public/agent/session.$sessionId.consent.ts.
        var decision = accepted ? "accept" : "decline";
        using var resp = await SendAuthedAsync(
            () => new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/session/{sessionId}/consent")
            {
                Content = JsonContent.Create(new { decision })
            }, ct);
        resp.EnsureSuccessStatusCode();
    }

    // Auto-enrollment + admin-initiated sessions replace the old meeting-code
    // pairing flow end to end (see ENDPOINTS.md).

    // Result type for /api/public/agent/session/{id}/reconnect.

    public sealed record ReconnectResult(bool Ok, string? SessionId, string? Error);
    private sealed record ReconnectOk(bool ok, string sessionId, string mode, string state);
    private sealed record ReconnectErr(string error);

    // ---- Reusable reconnect --------------------------------------------

    public async Task<ReconnectResult> ReconnectSessionAsync(string sessionId, string? code, CancellationToken ct)
    {
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/session/{sessionId}/reconnect")
                {
                    Content = JsonContent.Create(new { code })
                }, ct);
            var body = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
            {
                try
                {
                    var err = JsonSerializer.Deserialize<ReconnectErr>(body);
                    return new ReconnectResult(false, null, err?.error ?? resp.StatusCode.ToString());
                }
                catch { return new ReconnectResult(false, null, resp.StatusCode.ToString()); }
            }
            var ok = JsonSerializer.Deserialize<ReconnectOk>(body);
            if (!string.IsNullOrEmpty(ok?.sessionId)) SaveSessionBinding(new SessionBinding(ok.sessionId, code, DateTimeOffset.UtcNow));
            return new ReconnectResult(true, ok?.sessionId, null);
        }
        catch (Exception ex)
        {
            return new ReconnectResult(false, null, ex.Message);
        }
    }

    // ---- Live frame upload --------------------------------------------

    public async Task<bool> PostFrameAsync(string sessionId, byte[] jpegBytes, int width, int height, CancellationToken ct)
    {
        var payload = new
        {
            frame = Convert.ToBase64String(jpegBytes),
            width,
            height,
        };
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/session/{sessionId}/frame")
                {
                    Content = JsonContent.Create(payload),
                }, ct);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    // ---- Cursor telemetry (Phase-1: decoupled from frame stream) -------

    public async Task<bool> PostCursorAsync(string sessionId, int x, int y, int w, int h, string kind, bool visible, CancellationToken ct)
    {
        var payload = new { x, y, w, h, kind, visible };
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/session/{sessionId}/cursor")
                {
                    Content = JsonContent.Create(payload),
                }, ct);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    // ---- Admin input polling (mouse/keyboard from technician) ---------

    public async Task<(long max, System.Collections.Generic.List<JsonElement>? items)> PollInputsAsync(string sessionId, long since, CancellationToken ct)
    {
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Get, $"/api/public/agent/session/{sessionId}/inputs?since={since}"), ct);
            if (!resp.IsSuccessStatusCode) return (since, null);
            var body = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);
            long max = doc.RootElement.TryGetProperty("max", out var m) ? m.GetInt64() : since;
            var list = new System.Collections.Generic.List<JsonElement>();
            if (doc.RootElement.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array)
                foreach (var el in arr.EnumerateArray()) list.Add(el.Clone());
            return (max, list);
        }
        catch { return (since, null); }
    }

    // ---- WebRTC signaling ---------------------------------------------

    public async Task<bool> PostSignalAsync(string sessionId, string kind, object payload, CancellationToken ct, string? adminClientId = null, string? attemptId = null)
    {
        // admin_client_id + attempt_id: the former targets a specific admin
        // machine (routing + take-over), the latter makes retries idempotent
        // against the unique index ux_session_signals_attempt.
        var dict = new System.Collections.Generic.Dictionary<string, object?>
        {
            ["kind"] = kind,
            ["payload"] = payload,
        };
        if (adminClientId != null) dict["admin_client_id"] = adminClientId;
        if (attemptId != null) dict["attempt_id"] = attemptId;
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/session/{sessionId}/signal")
                {
                    Content = JsonContent.Create(dict),
                }, ct);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    // Retry queue wrapper — same-order FIFO, bounded exponential backoff.
    // ICE candidates dropped or re-ordered ahead of their answer would poison
    // negotiation, so we serialise per session via a lock keyed on session id.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> _signalLocks = new();

    public async Task PostSignalReliableAsync(string sessionId, string kind, object payload, CancellationToken ct, string? adminClientId = null)
    {
        var attempt = "agent-" + Guid.NewGuid().ToString("N").Substring(0, 12);
        var gate = _signalLocks.GetOrAdd(sessionId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            for (int i = 0; i < 6; i++)
            {
                if (await PostSignalAsync(sessionId, kind, payload, ct, adminClientId, attempt)) return;
                var backoff = Math.Min(4000, 250 * (int)Math.Pow(2, i));
                try { await Task.Delay(backoff, ct); } catch { return; }
            }
        }
        finally { gate.Release(); }
    }

    public async Task<(long max, System.Collections.Generic.List<JsonElement>? items)> PollSignalsAsync(string sessionId, long since, CancellationToken ct)
    {
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Get, $"/api/public/agent/session/{sessionId}/signal?since={since}"), ct);
            if (!resp.IsSuccessStatusCode) return (since, null);
            var body = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);
            long max = doc.RootElement.TryGetProperty("max", out var m) ? m.GetInt64() : since;
            var list = new System.Collections.Generic.List<JsonElement>();
            if (doc.RootElement.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array)
                foreach (var el in arr.EnumerateArray()) list.Add(el.Clone());
            return (max, list);
        }
        catch { return (since, null); }
    }

    // ---- (Removed) Realtime WebSocket ---------------------------------
    // Session invites and WebRTC signaling both travel over HTTPS
    // (heartbeat + /signal long-poll). Removing WS keeps the transport
    // surface minimal and eliminates a whole class of NAT/idle failures.

    // ---- DPAPI-encrypted local storage --------------------------------

    private void LoadDeviceCreds()
    {
        if (!File.Exists(DevicePath)) return;
        try
        {
            var enc = File.ReadAllBytes(DevicePath);
            var dec = ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine);
            var json = Encoding.UTF8.GetString(dec);
            var creds = JsonSerializer.Deserialize<EnrollResponse>(json);
            DeviceId = creds?.DeviceId;
            DeviceToken = creds?.DeviceToken;
        }
        catch { /* corrupt file: re-enroll */ }
    }

    private static void SaveDeviceCreds(EnrollResponse creds)
    {
        var json = JsonSerializer.Serialize(creds);
        var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(json), null, DataProtectionScope.LocalMachine);
        WriteHidden(DevicePath, enc);
    }

    public SessionBinding? LoadSessionBinding()
    {
        if (!File.Exists(SessionPath)) return null;
        try
        {
            var enc = File.ReadAllBytes(SessionPath);
            var dec = ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine);
            var json = Encoding.UTF8.GetString(dec);
            return JsonSerializer.Deserialize<SessionBinding>(json);
        }
        catch
        {
            ClearSessionBinding();
            return null;
        }
    }

    public static void SaveSessionBinding(SessionBinding binding)
    {
        var json = JsonSerializer.Serialize(binding);
        var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(json), null, DataProtectionScope.LocalMachine);
        WriteHidden(SessionPath, enc);
    }

    public static void ClearSessionBinding()
    {
        try { if (File.Exists(SessionPath)) File.Delete(SessionPath); } catch { }
    }

    private static AgentConfig? LoadConfig() =>
        File.Exists(ConfigPath) ? JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(ConfigPath)) : null;

    public static void SaveConfig(AgentConfig cfg) =>
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(cfg));

    // ---- DTOs ----------------------------------------------------------

    // ---- ICE configuration ---------------------------------------------

    private IceConfig? _iceCache;
    private DateTime _iceCacheUntilUtc = DateTime.MinValue;
    private readonly SemaphoreSlim _iceLock = new(1, 1);

    /// <summary>
    /// Server-issued ICE servers (STUN + Metered TURN relay). Credentials are
    /// short-lived and never baked into the binary; the backend mints them.
    /// Cached in-process for 40 minutes, well inside the credential lifetime,
    /// and re-fetched on demand after a failure.
    /// </summary>
    public async Task<IceConfig> GetIceServersAsync(CancellationToken ct)
    {
        if (_iceCache != null && DateTime.UtcNow < _iceCacheUntilUtc) return _iceCache;
        await _iceLock.WaitAsync(ct);
        try
        {
            if (_iceCache != null && DateTime.UtcNow < _iceCacheUntilUtc) return _iceCache;
            try
            {
                using var resp = await SendAuthedAsync(
                    () => new HttpRequestMessage(HttpMethod.Get, "/api/public/ice"), ct);
                resp.EnsureSuccessStatusCode();
                var cfg = await resp.Content.ReadFromJsonAsync<IceConfig>(cancellationToken: ct);
                if (cfg?.IceServers != null && cfg.IceServers.Count > 0)
                {
                    _iceCache = cfg;
                    // Failed/degraded lookups expire fast so a transient blip
                    // doesn't pin this process to STUN-only for the session.
                    _iceCacheUntilUtc = DateTime.UtcNow.AddMinutes(cfg.HasTurn ? 40 : 1);
                    return cfg;
                }
            }
            catch (Exception ex)
            {
                Log.Warn("ice config fetch failed: " + ex.Message);
            }
            var fallback = new IceConfig(
                new List<IceServerDto> { new IceServerDto("stun:stun.l.google.com:19302", null, null) },
                false, 10000);
            _iceCache = fallback;
            _iceCacheUntilUtc = DateTime.UtcNow.AddMinutes(1);
            return fallback;
        }
        finally { _iceLock.Release(); }
    }

    public sealed record IceServerDto(
        [property: JsonPropertyName("urls")] string Urls,
        [property: JsonPropertyName("username")] string? Username,
        [property: JsonPropertyName("credential")] string? Credential);

    public sealed record IceConfig(
        [property: JsonPropertyName("iceServers")] List<IceServerDto> IceServers,
        [property: JsonPropertyName("hasTurn")] bool HasTurn,
        [property: JsonPropertyName("connectTimeoutMs")] int ConnectTimeoutMs);

    public sealed record EnrollResponse(string DeviceId, string DeviceToken);
    public sealed record SessionBinding(string SessionId, string? PairingCode, DateTimeOffset SavedAt);
    public sealed record AgentConfig(string ApiBaseUrl);
}
