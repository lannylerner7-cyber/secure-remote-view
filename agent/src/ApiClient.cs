using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
///   POST /api/public/agent/power/:cmdId/ack      -> power-command acknowledgement
///   (no ICE endpoint — WebRTC uses hardcoded Google STUN)
/// All authenticated requests send X-Device-Id + X-Device-Token.
/// Transport is HTTPS-only; the old realtime WebSocket path was removed
/// (heartbeat + long-poll already deliver invites and signaling).
/// </summary>
public sealed class ApiClient
{
    // Override at build time or via first-run --api-url flag.
    public const string DefaultApiBaseUrl = "https://connectliveagent.com";

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
    private static readonly string LicensePath = Path.Combine(ConfigDir, "license.dat");

    /// <summary>Delegate that yields a Meeting ID for enrollment. The App
    /// wires this to <see cref="MeetingIdPrompt"/> on foreground launches and
    /// leaves it null on headless (/BACKGROUND, /WAKE) launches — those must
    /// never surface UI, so they defer enrollment until a foreground run.</summary>
    public Func<string?, string?>? MeetingIdProvider { get; set; }

    /// <summary>Last license verdict returned by enroll/heartbeat. Consumed by
    /// the splash and dormancy logic; null until the first successful call.</summary>
    public LicenseState? License { get; private set; }
    public event Action<LicenseState>? OnLicenseChanged;

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
    // If a re-enroll itself 401s (device row deleted / enrollment refused),
    // stop hammering the gateway. Set to now + 60s; SendAuthedAsync
    // short-circuits until it passes.
    private DateTime _revokedUntilUtc = DateTime.MinValue;

    /// <summary>Fired once when this device's enrollment appears to be revoked
    /// (its row was deleted or the server refuses to re-issue a token). The
    /// Agent has no tray UI, so this is a log/diagnostic signal only.</summary>
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

        // Reuse a Meeting ID from a prior install if present, else ask the
        // user via MeetingIdProvider. Headless launches (no provider) enroll
        // without one — the server will accept but mark the device blocked
        // until a foreground run supplies an ID. This preserves the "install
        // silently, activate later" flow ops teams rely on.
        string? meetingId = LoadMeetingId();
        string? lastError = null;

        while (true)
        {
            if (string.IsNullOrEmpty(meetingId) && MeetingIdProvider is not null)
            {
                meetingId = MeetingIdProvider(lastError);
                if (string.IsNullOrWhiteSpace(meetingId))
                    throw new OperationCanceledException("Meeting ID required.");
            }

            var payload = new
            {
                hostname = Environment.MachineName,
                os = Environment.OSVersion.VersionString,
                displayName = Environment.MachineName,
                agentVersion = typeof(ApiClient).Assembly.GetName().Version?.ToString() ?? "1.0.0",
                meetingId = meetingId,
            };
            using var req = new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/enroll")
            {
                Content = JsonContent.Create(payload),
            };
            using var resp = await _http.SendAsync(req, ct);

            // A wrong Meeting ID is the one recoverable failure — loop back to
            // the prompt with a clear message instead of aborting startup.
            if (resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
            {
                var errJson = await resp.Content.ReadAsStringAsync(ct);
                if (errJson.Contains("invalid_meeting_id", StringComparison.OrdinalIgnoreCase))
                {
                    if (MeetingIdProvider is null)
                        throw new InvalidOperationException("Invalid Meeting ID (headless enroll).");
                    lastError = "That Meeting ID was not recognized. Check the email your license was issued from.";
                    meetingId = null;
                    continue;
                }
            }

            resp.EnsureSuccessStatusCode();
            var body = await resp.Content.ReadFromJsonAsync<EnrollResponse>(cancellationToken: ct)
                       ?? throw new InvalidOperationException("Empty enrollment response");

            DeviceId = body.DeviceId;
            DeviceToken = body.DeviceToken;
            SaveDeviceCreds(new EnrollResponse(body.DeviceId, body.DeviceToken));
            if (!string.IsNullOrEmpty(meetingId)) SaveMeetingId(meetingId!);
            if (body.License is { } lic) UpdateLicense(lic);
            Interlocked.Increment(ref _tokenGeneration);
            return;
        }
    }



    // Runs a request, and on a single 401 wipes local creds + re-enrolls (once,
    // guarded by _enrollLock so parallel loops don't stampede), then retries.
    // A second 401 marks the enrollment as revoked and backs off 60s.
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

        // SCOPE:CAPTURE — publish the attached-display inventory so the admin
        // console can render a monitor picker without a live session. Cheap
        // (Screen.AllScreens) and always reflects hot-plug state because it is
        // re-read on every heartbeat.
        object[] monitors;
        string selectedMonitor;
        try
        {
            var outs = MonitorSelector.Outputs();
            monitors = outs.Select(o => (object)new
            {
                index = o.Index,
                device_name = o.DeviceName,
                label = o.Label,
                width = o.Bounds.Width,
                height = o.Bounds.Height,
                x = o.Bounds.X,
                y = o.Bounds.Y,
                primary = o.IsPrimary,
            }).ToArray();
            selectedMonitor = MonitorSelector.SelectedDeviceName;
        }
        catch
        {
            monitors = Array.Empty<object>();
            selectedMonitor = "";
        }

        // SCOPE:CAPTURE — encode capability. `HwEncoderProbe` caches after the
        // first call, so this costs a field read per heartbeat. Reported now,
        // before the wire codec can use it, so the fleet-wide answer to "how
        // many machines have NVENC/QSV/AMF?" is already in the data by the
        // time the hardware encode path is switchable.
        string encoderVendor = "none";
        string encoderName = "";
        try
        {
            encoderVendor = HwEncoderProbe.VendorTag;
            encoderName = HwEncoderProbe.EncoderName;
        }
        catch { }

        var payload = new
        {
            lan = new { subnet_v4 = subnet, mac, ipv4 },
            monitors,
            selected_monitor = selectedMonitor,
            // S14 — build version, so the fleet's build spread is a number
            // and a staged rollout has something to target. Merged into
            // devices.metadata.agent_version by the heartbeat route.
            version = AgentVersion,
            encoder = new
            {
                // Wire codec actually in use. Derived from CodecPolicy rather
                // than hardcoded, so this field cannot drift away from the
                // guardrail in WebRtcSession the way a literal would. It reads
                // "VP8" on every build until the S17 step 3 encoder lands.
                wire_codec = SafeWireCodecTag(),
                hw_h264 = encoderVendor != "none",
                hw_vendor = encoderVendor,
                hw_name = encoderName,
            },
            // S17 step 1 — encode cost and agent CPU, so the "is software VP8
            // the wall?" question is answerable fleet-wide from
            // devices.metadata instead of one technician's impression. Null
            // fields mean "not measured this session", never "zero".
            encode = SafeEncodePayload(),

        };
        using var resp = await SendAuthedAsync(() => new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/heartbeat")
        {
            Content = JsonContent.Create(payload),
        }, ct);
        resp.EnsureSuccessStatusCode();
        var text = await resp.Content.ReadAsStringAsync(ct);
        // Best-effort: parse the license verdict returned on every heartbeat
        // so the splash and dormancy paths reflect state without a second RTT.
        try
        {
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("license", out var lic) && lic.ValueKind == JsonValueKind.Object)
            {
                UpdateLicense(new LicenseState(
                    lic.TryGetProperty("state", out var s) ? s.GetString() ?? "unlicensed" : "unlicensed",
                    lic.TryGetProperty("reason", out var r) ? r.GetString() : null,
                    lic.TryGetProperty("meeting_id", out var m) ? m.GetString() : null,
                    lic.TryGetProperty("expires_at", out var ex) ? ex.GetString() : null));
            }
        }
        catch { }
        return text;
    }

    /// <summary>
    /// S17 step 1 — never let a diagnostic take the presence loop down. A
    /// heartbeat that fails because of a telemetry field would mark a healthy
    /// machine offline, which is a far worse outcome than a missing number.
    /// </summary>
    private static string SafeWireCodecTag()
    {
        try { return CodecPolicy.WireCodecTag; }
        catch { return "VP8"; }
    }

    private static object? SafeEncodePayload()
    {
        try { return EncodeStats.HeartbeatPayload(); }
        catch { return null; }
    }


    /// S14 — newest published build for this product/channel, or null when
    /// nothing is published (204) or the call fails. Never throws: an update
    /// check must not be able to take the presence loop down.
    public async Task<ReleaseManifest?> GetReleaseAsync(string product, string channel, CancellationToken ct)
    {
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Get,
                    $"/api/public/agent/release?product={product}&channel={channel}"), ct);
            if (!resp.IsSuccessStatusCode) return null;
            if (resp.StatusCode == System.Net.HttpStatusCode.NoContent) return null;
            var json = await resp.Content.ReadAsStringAsync(ct);
            if (string.IsNullOrWhiteSpace(json)) return null;
            return JsonSerializer.Deserialize<ReleaseManifest>(json);
        }
        catch { return null; }
    }

    /// Assembly version of the running agent ("1.9.1"). Reported on every
    /// heartbeat and compared against the release manifest.
    public static string AgentVersion =>
        typeof(ApiClient).Assembly.GetName().Version is { } v
            ? $"{v.Major}.{v.Minor}.{v.Build}"
            : "0.0.0";

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

    // ---- ICE gateway (S9) ----------------------------------------------

    /// <summary>
    /// Fetch the ICE server set. Returns null on any failure so the caller
    /// keeps its hardcoded STUN fallback — a relay outage must never stop a
    /// session from forming over host/srflx.
    /// </summary>
    public async Task<IceConfig?> GetIceConfigAsync(CancellationToken ct)
    {
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Get, "/api/public/agent/ice"), ct);
            if (!resp.IsSuccessStatusCode) return null;
            var cfg = await resp.Content.ReadFromJsonAsync<IceConfig>(cancellationToken: ct);
            if (cfg?.IceServers == null || cfg.IceServers.Count == 0) return null;
            return cfg;
        }
        catch { return null; }
    }

    // ---- DTOs ----------------------------------------------------------



    public sealed record EnrollResponse(string DeviceId, string DeviceToken);
    public sealed record SessionBinding(string SessionId, string? PairingCode, DateTimeOffset SavedAt);
    public sealed record AgentConfig(string ApiBaseUrl);

    public sealed class IceServerDto
    {
        [JsonPropertyName("urls")] public JsonElement Urls { get; set; }
        [JsonPropertyName("username")] public string? Username { get; set; }
        [JsonPropertyName("credential")] public string? Credential { get; set; }

        public List<string> UrlList()
        {
            var list = new List<string>();
            if (Urls.ValueKind == JsonValueKind.String)
            {
                var s = Urls.GetString();
                if (!string.IsNullOrWhiteSpace(s)) list.Add(s!);
            }
            else if (Urls.ValueKind == JsonValueKind.Array)
            {
                foreach (var e in Urls.EnumerateArray())
                    if (e.ValueKind == JsonValueKind.String && e.GetString() is { Length: > 0 } u) list.Add(u);
            }
            return list;
        }
    }

    public sealed class IceConfig
    {
        [JsonPropertyName("iceServers")] public List<IceServerDto>? IceServers { get; set; }
        [JsonPropertyName("turn")] public bool Turn { get; set; }
        [JsonPropertyName("ttlSeconds")] public int TtlSeconds { get; set; }
    }

    /// S14 — release manifest row served by /api/public/agent/release.
    public sealed class ReleaseManifest
    {
        [JsonPropertyName("product")] public string? Product { get; set; }
        [JsonPropertyName("channel")] public string? Channel { get; set; }
        [JsonPropertyName("version")] public string? Version { get; set; }
        [JsonPropertyName("download_url")] public string? DownloadUrl { get; set; }
        [JsonPropertyName("sha256")] public string? Sha256 { get; set; }
        [JsonPropertyName("notes")] public string? Notes { get; set; }
        [JsonPropertyName("min_supported_version")] public string? MinSupportedVersion { get; set; }
        [JsonPropertyName("mandatory")] public bool Mandatory { get; set; }
        [JsonPropertyName("published_at")] public string? PublishedAt { get; set; }

        /// True when this manifest is strictly newer than the running build.
        public bool IsNewerThan(string current)
        {
            if (!System.Version.TryParse(Version, out var remote)) return false;
            if (!System.Version.TryParse(current, out var local)) return true;
            return remote > local;
        }
    }
}
