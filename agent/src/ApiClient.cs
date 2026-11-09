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
///   GET /api/public/agent/ice?sessionId=... -> authorized session ICE settings
/// All authenticated requests send X-Device-Id + X-Device-Token.
/// Transport is HTTPS-only; the old realtime WebSocket path was removed
/// (heartbeat + long-poll already deliver invites and signaling).
/// </summary>
public sealed partial class ApiClient
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

    /// <summary>Available only during explicit foreground enrollment.
    /// Background starts and later authentication failures never open a prompt
    /// or silently create a replacement device.</summary>
    internal Func<CancellationToken, Task<bool>>? PairingProvider { get; set; }

    /// <summary>Last license verdict returned by enroll/heartbeat. Consumed by
    /// diagnostic and dormancy logic; null until the first successful call.</summary>
    public LicenseState? License { get; private set; }
    public event Action<LicenseState>? OnLicenseChanged;

    private readonly HttpClient _http;
    private readonly AgentHttpDiagnostics _httpDiagnostics = new((line, warning) =>
    {
        if (warning) Log.Warn(line); else Log.Info(line);
    });
    public string ApiBaseUrl { get; }
    public string? DeviceId { get; private set; }
    public string? DeviceToken { get; private set; }
    internal LocalGrant? LocalAuthorization { get; set; }
    internal PeerInputPermission? LivePermission { get; set; }
    internal string? LiveSessionId { get; set; }
    internal bool LiveVideoOnly { get; set; }
    internal event Action? LiveAuthorityRejected;
    internal bool Allows(string sessionId, string scope, CancellationToken ct) =>
        !ct.IsCancellationRequested && LiveSessionId == sessionId && LivePermission?.Allows(scope) == true;

    internal async Task RecordAuthorizationAsync(string mode, GrantScopes scopes, CancellationToken ct)
    {
        var agreedDeviceId = DeviceId;
        LocalAuthorization = null;
        using var resp = await SendAuthedAsync(() => new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/authorization")
        {
            Content = JsonContent.Create(new { noticeVersion = 1, mode, capabilities = new {
                view = scopes.View, control = scopes.Control, clipboard = scopes.Clipboard,
                files = scopes.Files, recording = scopes.Recording } })
        }, ct);
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
        var root = doc.RootElement;
        var grant = root.TryGetProperty("authorization", out var a) ? AuthorizationGrant.Parse(a) : null;
        if (!root.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True ||
            grant == null || grant.Mode != mode || grant.Capabilities != scopes ||
            DeviceId == null || DeviceId != agreedDeviceId)
            throw new InvalidOperationException("Authorization response did not match your choices; remote access remains dormant.");
        var local = new LocalGrant(LocalGrant.OriginOf(ApiBaseUrl), DeviceId, grant);
        GrantStore.Save(local);
        LocalAuthorization = local;
    }

    internal async Task RevokeAuthorizationAsync(CancellationToken ct)
    {
        using var resp = await SendAuthedAsync(() => new HttpRequestMessage(HttpMethod.Post,
            "/api/public/agent/authorization/revoke"), ct);
        resp.EnsureSuccessStatusCode();
    }

    public ApiClient(string? overrideBaseUrl = null)
    {
        Directory.CreateDirectory(ConfigDir);
        HideStore();
        MigrateLegacyStore();
        ApiBaseUrl = ConnectLive.Native.NativeGatewayPolicy.ValidateOrigin(
            overrideBaseUrl ?? LoadConfig()?.ApiBaseUrl ?? DefaultApiBaseUrl, "apiBaseUrl");
        _http = new HttpClient(ConnectLive.Native.NativeGatewayPolicy.CreateHandler())
            { BaseAddress = new Uri(ApiBaseUrl), Timeout = TimeSpan.FromSeconds(20) };
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

    // ---- Enrollment ----------------------------------------------------

    public async Task EnrollIfNeededAsync(CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(DeviceToken)) return;
        if (PairingProvider == null)
            throw new InvalidOperationException("Pairing required — open ConnectLive in the foreground. Background enrollment is disabled.");
        if (!await PairingProvider(ct) || string.IsNullOrEmpty(DeviceToken) || LocalAuthorization == null)
            throw new OperationCanceledException("Pairing was not completed.");
    }

    public async Task HelloAsync(CancellationToken ct)
    {
        using var resp = await SendAuthedAsync(
            () => new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/hello"), ct);
        resp.EnsureSuccessStatusCode();
    }

    private long _runtimeSequence;
    internal int HeartbeatSeconds { get; set; } = 10;
    public async Task<string> HeartbeatAsync(CancellationToken ct)
    {
        if (LocalAuthorization is { } local) AgentProcessState.Announce(local.Authorization.Id);
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
            // Keep the last accepted session ID through a channel loss. Only
            // an explicit matching terminal receipt can request re-pairing.
            observed_session_id = LiveSessionId,
            lan = new { subnet_v4 = subnet, mac, ipv4 },
            monitors,
            selected_monitor = selectedMonitor,
            // S14 — build version, so the fleet's build spread is a number
            // and a staged rollout has something to target. Merged into
            // devices.metadata.agent_version by the heartbeat route.
            version = AgentVersion,
            browserVideo = 1,
            browserCurtain = OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041) ? 1 : 0,
            runtime = new {
                instance = AgentProcessState.Instance,
                sequence = System.Threading.Interlocked.Increment(ref _runtimeSequence),
                heartbeat_seconds = Math.Clamp(HeartbeatSeconds, 5, 60),
            },
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
        }, ct, AgentHttpOperation.Heartbeat);
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
                Content = JsonContent.Create(new { decision, authorizationId = LocalAuthorization?.Authorization.Id, noticeVersion = 1 })
            }, ct);
        resp.EnsureSuccessStatusCode();
    }

    // Reconnect keeps the existing explicitly paired device identity.

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
        if (UnlockOperation.Sensitive ||
            ConnectLive.Unlock.WindowsSession.Locked(ConnectLive.Unlock.WindowsSession.CurrentId) == true) return false;
        var permission = LivePermission;
        if (!Allows(sessionId, "view", ct) || permission == null) return false;
        // Same three-second budget as the capture pump previously applied.
        // Keep the lifetime token separate so withdrawal/session teardown is
        // not mislabeled as an upload deadline or network failure.
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, permission.Token);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(3));
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
                }, deadline.Token, AgentHttpOperation.Frame, lifetime.Token);
            return resp.IsSuccessStatusCode;
        }
        catch (OperationCanceledException) { return false; }
        catch { return false; } // HTTP failures are observed before authority handling.
    }

    // ---- Step 10: session file chunk upload (DataChannel fallback) -----
    //
    // Mirrors src/routes/api/public/agent/session.$sessionId.file.ts. Chunks
    // land as discrete part objects; the eof=1 request stitches them, enforces
    // the 500 MiB / 5 GiB quotas and writes the session_files manifest row.
    public async Task<bool> UploadSessionFileChunkAsync(
        string sessionId, string fileId, int seq, bool eof,
        string name, string mime, string sha256, long totalSize,
        byte[] chunk, CancellationToken ct)
    {
        if (!Allows(sessionId, "files", ct)) return false;
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, LivePermission!.Token);
        ct = lifetime.Token;
        try
        {
            var path = $"/api/public/agent/session/{sessionId}/file" +
                       $"?fileId={Uri.EscapeDataString(fileId)}&seq={seq}" + (eof ? "&eof=1" : "");
            using var resp = await SendAuthedAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Post, path)
                {
                    Content = new ByteArrayContent(chunk ?? Array.Empty<byte>()),
                };
                req.Content.Headers.ContentType =
                    new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
                req.Headers.Add("X-File-Name", name);
                req.Headers.Add("X-File-Mime", mime);
                req.Headers.Add("X-File-Sha256", sha256);
                req.Headers.Add("X-File-Size", totalSize.ToString());
                return req;
            }, ct);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    // ---- Cursor telemetry (Phase-1: decoupled from frame stream) -------


    public async Task<bool> PostCursorAsync(string sessionId, int x, int y, int w, int h, string kind, bool visible, CancellationToken ct)
    {
        if (!Allows(sessionId, "view", ct)) return false;
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
        if (!Allows(sessionId, "control", ct)) return (since, null);
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

    // Signal-poll failures used to be swallowed completely. A 403/404/409 from
    // the gateway, or a transport fault, left the Agent silently never answering
    // an offer — indistinguishable from a healthy idle session. Log state
    // *changes* only (first failure, each distinct status, and recovery) so a
    // long outage does not flood the file at the 500 ms poll cadence.
    private string? _lastSignalPollFailure;
    private long _signalPollFailures;

    public async Task<(long max, System.Collections.Generic.List<JsonElement>? items)> PollSignalsAsync(string sessionId, long since, CancellationToken ct)
    {
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Get, $"/api/public/agent/session/{sessionId}/signal?since={since}"), ct);
            if (!resp.IsSuccessStatusCode)
            {
                // Proxy/upstream error bodies can contain credentials or URLs.
                NoteSignalPollFailure($"HTTP {(int)resp.StatusCode}");
                return (since, null);
            }
            var body = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);
            long max = doc.RootElement.TryGetProperty("max", out var m) ? m.GetInt64() : since;
            var list = new System.Collections.Generic.List<JsonElement>();
            if (doc.RootElement.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array)
                foreach (var el in arr.EnumerateArray()) list.Add(el.Clone());
            NoteSignalPollRecovered();
            return (max, list);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { return (since, null); }
        catch (Exception ex)
        {
            NoteSignalPollFailure(AgentHttpDiagnostics.SafeFailure(ex, ct.IsCancellationRequested));
            return (since, null);
        }
    }

    private void NoteSignalPollFailure(string reason)
    {
        _signalPollFailures++;
        if (string.Equals(_lastSignalPollFailure, reason, StringComparison.Ordinal)) return;
        _lastSignalPollFailure = reason;
        Log.Warn($"webrtc signal poll failing: {reason}");
    }

    private void NoteSignalPollRecovered()
    {
        if (_lastSignalPollFailure == null) return;
        Log.Info($"webrtc signal poll recovered after {_signalPollFailures} failed poll(s)");
        _lastSignalPollFailure = null;
        _signalPollFailures = 0;
    }

    // ---- (Removed) Realtime WebSocket ---------------------------------
    // Session invites and WebRTC signaling both travel over HTTPS
    // (heartbeat + /signal long-poll). Removing WS keeps the transport
    // surface minimal and eliminates a whole class of NAT/idle failures.

    // ---- DPAPI-encrypted local storage --------------------------------

    // Local credential store: kept as its own POCO so wire attribute changes
    // on EnrollResponse (added camelCase JsonPropertyName + optional license)
    // can never break older device.dat blobs, which were serialised with
    // System.Text.Json defaults (PascalCase, no license field).
    private sealed record StoredCreds(string DeviceId, string DeviceToken);
    private static readonly JsonSerializerOptions _credsRead = new() { PropertyNameCaseInsensitive = true };

    private void LoadDeviceCreds()
    {
        if (!File.Exists(DevicePath)) return;
        try
        {
            var enc = File.ReadAllBytes(DevicePath);
            var dec = ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine);
            var json = Encoding.UTF8.GetString(dec);
            var creds = JsonSerializer.Deserialize<StoredCreds>(json, _credsRead);
            DeviceId = creds?.DeviceId;
            DeviceToken = creds?.DeviceToken;
        }
        catch { /* corrupt file: re-enroll */ }
    }

    private static void SaveDeviceCreds(EnrollResponse creds)
    {
        var json = JsonSerializer.Serialize(new StoredCreds(creds.DeviceId, creds.DeviceToken));
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

    public static void SaveConfig(AgentConfig cfg)
    {
        var origin = ConnectLive.Native.NativeGatewayPolicy.ValidateOrigin(cfg.ApiBaseUrl, "apiBaseUrl");
        ConfigFile.Write(ConfigPath, JsonSerializer.Serialize(new AgentConfig(origin)));
    }

    // ---- ICE gateway (S9) ----------------------------------------------

    /// <summary>
    /// Fetch the ICE server set. Returns null on gateway outages so the caller
    /// keeps its hardcoded STUN fallback — a relay outage must never stop a
    /// session from forming over host/srflx. Cancellation and authorization
    /// failure are never converted into successful fallback.
    /// </summary>
    public async Task<IceConfig?> GetIceConfigAsync(string sessionId, CancellationToken ct)
    {
        if (!Allows(sessionId, "view", ct))
            throw new UnauthorizedAccessException("Session viewing authorization is no longer active.");
        try
        {
            using var resp = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Get, ConnectLive.Native.NativeGatewayPolicy.IcePath(sessionId)), ct);
            if (resp.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden)
                throw new UnauthorizedAccessException("ICE authorization was rejected. Reconnect with an authorized session.");
            if (!resp.IsSuccessStatusCode) return null;
            var cfg = await resp.Content.ReadFromJsonAsync<IceConfig>(cancellationToken: ct);
            if (cfg?.IceServers == null || cfg.IceServers.Count == 0) return null;
            return cfg;
        }
        catch (OperationCanceledException) { throw; }
        catch (UnauthorizedAccessException) { throw; }
        catch (HttpRequestException) when (!Allows(sessionId, "view", ct)) { throw; }
        catch { return null; }
    }

    // ---- DTOs ----------------------------------------------------------



    public sealed record EnrollResponse(
        [property: JsonPropertyName("deviceId")] string DeviceId,
        [property: JsonPropertyName("deviceToken")] string DeviceToken,
        [property: JsonPropertyName("license")] LicenseState? License = null);

    /// <summary>License verdict shipped on enroll + every heartbeat. The Agent
    /// stays online in every state; only "active" and "unlicensed" (pre-
    /// licensing / direct admin enrollment) actually accept sessions.</summary>
    public sealed record LicenseState(
        [property: JsonPropertyName("state")] string State,
        [property: JsonPropertyName("reason")] string? Reason,
        [property: JsonPropertyName("meeting_id")] string? MeetingId,
        [property: JsonPropertyName("expires_at")] string? ExpiresAt);

    private void UpdateLicense(LicenseState next)
    {
        var prev = License;
        License = next;
        if (prev is null || prev.State != next.State || prev.Reason != next.Reason)
        {
            try { OnLicenseChanged?.Invoke(next); } catch { }
        }
    }

    private static string? LoadMeetingId()
    {
        try
        {
            if (!File.Exists(LicensePath)) return null;
            var enc = File.ReadAllBytes(LicensePath);
            var dec = ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(dec).Trim();
        }
        catch { return null; }
    }

    private static void SaveMeetingId(string meetingId)
    {
        try
        {
            var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(meetingId), null, DataProtectionScope.LocalMachine);
            WriteHidden(LicensePath, enc);
        }
        catch { }
    }
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
        [JsonPropertyName("provider")] public string? Provider { get; set; }
        [JsonPropertyName("serverProtocol")] public int? ServerProtocol { get; set; }
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
