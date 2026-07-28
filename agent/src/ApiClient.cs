using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Thin HTTP client for the ConnectLive gateway.
/// Routes (kept in sync with src/shared/api-routes.ts):
///   POST /api/public/agent/enroll               -> { deviceId, deviceToken }  (gated by X-Deployment-Key)
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
    public const string DefaultApiBaseUrl = "https://secure-remote-view.lovable.app";

    private static readonly string ConfigDir =
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
        ApiBaseUrl = overrideBaseUrl ?? LoadConfig()?.ApiBaseUrl ?? DefaultApiBaseUrl;
        _http = new HttpClient { BaseAddress = new Uri(ApiBaseUrl), Timeout = TimeSpan.FromSeconds(20) };
        LoadDeviceCreds();
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

        var deploymentKey = DeploymentKey.Resolve()
            ?? throw new InvalidOperationException(
                "No deployment key found. Drop the key at %ProgramData%\\ConnectLive\\deployment.key " +
                "or set AGENT_DEPLOYMENT_KEY before running.");

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
        req.Headers.Add("X-Deployment-Key", deploymentKey);
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

    // ---- (Removed) Meeting-code pairing --------------------------------
    // The old /api/public/agent/pair endpoint returns 410 Gone; auto-enroll
    // + admin-initiated session creation replaces it end-to-end.

    public sealed record PairResult(bool Ok, string? SessionId, string? Error);
    private sealed record PairOk(bool ok, string sessionId, string mode, string state);
    private sealed record PairErr(string error);

    // ---- Reusable reconnect --------------------------------------------

    public async Task<PairResult> ReconnectSessionAsync(string sessionId, string? code, CancellationToken ct)
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
                    var err = JsonSerializer.Deserialize<PairErr>(body);
                    return new PairResult(false, null, err?.error ?? resp.StatusCode.ToString());
                }
                catch { return new PairResult(false, null, resp.StatusCode.ToString()); }
            }
            var ok = JsonSerializer.Deserialize<PairOk>(body);
            if (!string.IsNullOrEmpty(ok?.sessionId)) SaveSessionBinding(new SessionBinding(ok.sessionId, code, DateTimeOffset.UtcNow));
            return new PairResult(true, ok?.sessionId, null);
        }
        catch (Exception ex)
        {
            return new PairResult(false, null, ex.Message);
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

    public async Task<bool> PostSignalAsync(string sessionId, string kind, object payload, CancellationToken ct, string? adminClientId = null)
    {
        // admin_client_id targets a specific admin machine — required so that
        // (a) the answering admin's poller picks up our answer/ICE, and
        // (b) a "terminated" packet meant for a superseded admin only closes
        //     that admin's WebRTC client, not the new one that just took over.
        object body = adminClientId is null
            ? new { kind, payload }
            : new { kind, payload, admin_client_id = adminClientId };
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/session/{sessionId}/signal")
                {
                    Content = JsonContent.Create(body),
                }, ct);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
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
        File.WriteAllBytes(DevicePath, enc);
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
        File.WriteAllBytes(SessionPath, enc);
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

    public sealed record EnrollResponse(string DeviceId, string DeviceToken);
    public sealed record SessionBinding(string SessionId, string? PairingCode, DateTimeOffset SavedAt);
    public sealed record AgentConfig(string ApiBaseUrl);
}
