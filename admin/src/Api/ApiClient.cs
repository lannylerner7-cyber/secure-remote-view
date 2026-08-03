using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Api;

/// <summary>
/// HTTP client that talks to:
///   - ConnectLive gateway (custom /api/public/auth/login)
///   - Supabase REST + Auth (for device list, sessions, session_inputs, cursors, signals)
///
/// Auth model: after /api/public/auth/login succeeds, we hold a Supabase access
/// token. Every Supabase REST call sends both:
///     apikey: <publishable key>
///     Authorization: Bearer <access_token>
/// so RLS runs as the signed-in technician.
/// </summary>
public sealed class ApiClient
{
    private readonly AppConfig _config;
    private readonly AuthStore _auth;
    private readonly HttpClient _http;

    public ApiClient(AppConfig config, AuthStore auth)
    {
        _config = config;
        _auth = auth;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
    }

    // ---------- Login (custom endpoint with lockout) ----------

    public async Task<LoginResponse> LoginAsync(string identifier, string password, CancellationToken ct)
    {
        var url = $"{_config.BaseUrl}/api/public/auth/login";
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Content = JsonContent.Create(new { identifier, password });
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var parsed = JsonSerializer.Deserialize<LoginResponse>(body) ?? new LoginResponse();

        if (res.IsSuccessStatusCode && parsed.Session != null)
        {
            // Decode expiry from JWT payload
            long expiresAt = DecodeJwtExpiry(parsed.Session.AccessToken);
            string userId = DecodeJwtSubject(parsed.Session.AccessToken);
            _auth.Save(new AuthStore.Session
            {
                AccessToken = parsed.Session.AccessToken,
                RefreshToken = parsed.Session.RefreshToken,
                ExpiresAt = expiresAt,
                UserId = userId,
            });
        }
        return parsed;
    }

    public async Task<bool> RefreshSessionAsync(CancellationToken ct)
    {
        if (_auth.Current == null || string.IsNullOrEmpty(_auth.Current.RefreshToken)) return false;
        var url = $"{_config.SupabaseUrl}/auth/v1/token?grant_type=refresh_token";
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Add("apikey", _config.SupabaseAnonKey);
        req.Content = JsonContent.Create(new { refresh_token = _auth.Current.RefreshToken });
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) return false;
        var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct), cancellationToken: ct).ConfigureAwait(false);
        var access = doc.RootElement.GetProperty("access_token").GetString() ?? "";
        var refresh = doc.RootElement.GetProperty("refresh_token").GetString() ?? "";
        _auth.Save(new AuthStore.Session
        {
            AccessToken = access,
            RefreshToken = refresh,
            ExpiresAt = DecodeJwtExpiry(access),
            UserId = DecodeJwtSubject(access),
        });
        return true;
    }

    public void Logout() => _auth.Clear();

    // ---------- ICE gateway (S9) ----------

    public sealed record IceServerInfo(List<string> Urls, string? Username, string? Credential);

    /// <summary>
    /// Fetch the ICE set from /api/public/agent/ice using the technician JWT.
    /// Returns an empty list on any failure so the caller keeps its STUN
    /// fallback — a relay outage must not prevent a direct connection.
    /// </summary>
    public async Task<List<IceServerInfo>> GetIceServersAsync(CancellationToken ct)
    {
        var result = new List<IceServerInfo>();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{_config.BaseUrl}/api/public/agent/ice");
            if (_auth.Current != null && !string.IsNullOrEmpty(_auth.Current.AccessToken))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.Current.AccessToken);
            using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode) return result;
            using var doc = await JsonDocument.ParseAsync(
                await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false), cancellationToken: ct).ConfigureAwait(false);
            if (!doc.RootElement.TryGetProperty("iceServers", out var servers)
                || servers.ValueKind != JsonValueKind.Array) return result;

            foreach (var s in servers.EnumerateArray())
            {
                var urls = new List<string>();
                if (s.TryGetProperty("urls", out var u))
                {
                    if (u.ValueKind == JsonValueKind.String && u.GetString() is { Length: > 0 } one) urls.Add(one);
                    else if (u.ValueKind == JsonValueKind.Array)
                        foreach (var e in u.EnumerateArray())
                            if (e.ValueKind == JsonValueKind.String && e.GetString() is { Length: > 0 } m) urls.Add(m);
                }
                if (urls.Count == 0) continue;
                string? user = s.TryGetProperty("username", out var un) && un.ValueKind == JsonValueKind.String ? un.GetString() : null;
                string? cred = s.TryGetProperty("credential", out var cr) && cr.ValueKind == JsonValueKind.String ? cr.GetString() : null;
                result.Add(new IceServerInfo(urls, user, cred));
            }
        }
        catch { /* fallback to STUN */ }
        return result;
    }

    // ---------- Supabase REST helpers ----------

    private HttpRequestMessage NewSupabase(HttpMethod method, string path)
    {
        var req = new HttpRequestMessage(method, $"{_config.SupabaseUrl}{path}");
        req.Headers.Add("apikey", _config.SupabaseAnonKey);
        if (_auth.Current != null && !string.IsNullOrEmpty(_auth.Current.AccessToken))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.Current.AccessToken);
        return req;
    }

    private async Task<HttpResponseMessage> SendSupabaseAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            res.Dispose();
            if (await RefreshSessionAsync(ct))
            {
                var clone = await CloneAsync(req).ConfigureAwait(false);
                if (clone.Headers.Authorization != null && _auth.Current != null)
                    clone.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.Current.AccessToken);
                return await _http.SendAsync(clone, ct).ConfigureAwait(false);
            }
        }
        return res;
    }

    // Throwing variant — non-2xx surfaces as SupabaseCallException with the
    // response body attached so ViewModels can show the actual PostgREST error
    // (RLS denial, constraint violation, expired token) instead of the UI
    // silently freezing on a background loop failure.
    private async Task EnsureOkAsync(HttpResponseMessage res, string context, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        string body = "";
        try { body = await res.Content.ReadAsStringAsync(ct); } catch { }
        throw new SupabaseCallException(context, (int)res.StatusCode, body);
    }

    private static async Task<HttpRequestMessage> CloneAsync(HttpRequestMessage req)
    {
        var clone = new HttpRequestMessage(req.Method, req.RequestUri);
        foreach (var h in req.Headers) clone.Headers.TryAddWithoutValidation(h.Key, h.Value);
        if (req.Content != null)
        {
            var s = await req.Content.ReadAsStringAsync().ConfigureAwait(false);
            clone.Content = new StringContent(s, Encoding.UTF8, req.Content.Headers.ContentType?.MediaType ?? "application/json");
        }
        return clone;
    }

    public async Task<List<DeviceRow>> ListDevicesAsync(CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Get,
            "/rest/v1/devices?select=id,device_id,display_name,hostname,os,last_seen_at,status,is_session_active,metadata&order=last_seen_at.desc");
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "list devices", ct).ConfigureAwait(false);
        var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        return await JsonSerializer.DeserializeAsync<List<DeviceRow>>(stream, cancellationToken: ct)
               ?? new List<DeviceRow>();
    }

    /// <summary>
    /// Single-row fetch used by the live session window's monitor picker, so
    /// it can track hot-plugged displays without pulling the whole grid.
    /// </summary>
    public async Task<DeviceRow?> GetDeviceAsync(string deviceRowId, CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Get,
            $"/rest/v1/devices?select=id,device_id,display_name,hostname,os,last_seen_at,status,is_session_active,metadata&id=eq.{Uri.EscapeDataString(deviceRowId)}&limit=1");
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "get device", ct).ConfigureAwait(false);
        var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        var list = await JsonSerializer.DeserializeAsync<List<DeviceRow>>(stream, cancellationToken: ct).ConfigureAwait(false);
        return list is { Count: > 0 } ? list[0] : null;
    }

    public async Task DeleteDeviceAsync(string deviceRowId, CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Delete, $"/rest/v1/devices?id=eq.{Uri.EscapeDataString(deviceRowId)}");
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "delete device", ct).ConfigureAwait(false);
    }

    public async Task<SessionRow> CreateSessionAsync(string deviceRowId, string mode, CancellationToken ct)
    {
        // Reuse the newest live session for this device if one already exists
        // (any state in invited/consented/active/paused). Inserting a fresh
        // row every click made the agent's session-loop iterator settle on
        // the OLDEST session id and push frames to a session no admin was
        // polling — the black-screen bug. We take over the existing row by
        // stamping our admin_client_id + technician_id on it instead.
        using (var lookup = NewSupabase(HttpMethod.Get,
            $"/rest/v1/sessions?select=*&device_id=eq.{Uri.EscapeDataString(deviceRowId)}" +
            $"&state=in.(invited,consented,active,paused)&order=created_at.desc&limit=1"))
        {
            using var lookupRes = await SendSupabaseAsync(lookup, ct).ConfigureAwait(false);
            await EnsureOkAsync(lookupRes, "find live session", ct).ConfigureAwait(false);
            var lookupStream = await lookupRes.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var existing = await JsonSerializer.DeserializeAsync<List<SessionRow>>(lookupStream, cancellationToken: ct).ConfigureAwait(false);
            if (existing != null && existing.Count > 0)
            {
                var current = existing[0];
                using var patch = NewSupabase(new HttpMethod("PATCH"),
                    $"/rest/v1/sessions?id=eq.{Uri.EscapeDataString(current.Id)}&select=*");
                patch.Headers.Add("Prefer", "return=representation");
                patch.Content = JsonContent.Create(new
                {
                    mode,
                    admin_client_id = App.ClientId,
                    technician_id = _auth.Current?.UserId,
                });
                using var patchRes = await SendSupabaseAsync(patch, ct).ConfigureAwait(false);
                await EnsureOkAsync(patchRes, "reuse session", ct).ConfigureAwait(false);
                var patchStream = await patchRes.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                var patched = await JsonSerializer.DeserializeAsync<List<SessionRow>>(patchStream, cancellationToken: ct).ConfigureAwait(false);
                if (patched != null && patched.Count > 0) return patched[0];
                return current;
            }
        }

        using var req = NewSupabase(HttpMethod.Post, "/rest/v1/sessions?select=*");
        req.Headers.Add("Prefer", "return=representation");
        // technician_id + admin_client_id are REQUIRED for RLS + take-over routing:
        //   - technician_id satisfies the "Staff create own sessions" INSERT policy for
        //     paired admins (super_admins bypass, but sending it keeps both paths equal).
        //   - admin_client_id lets the agent route WebRTC/input to THIS physical box.
        req.Content = JsonContent.Create(new
        {
            device_id = deviceRowId,
            mode,
            state = "invited",
            technician_id = _auth.Current?.UserId,
            admin_client_id = App.ClientId,
        });
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "create session", ct).ConfigureAwait(false);
        var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        var list = await JsonSerializer.DeserializeAsync<List<SessionRow>>(stream, cancellationToken: ct).ConfigureAwait(false);
        if (list == null || list.Count == 0)
            throw new SupabaseCallException("create session", 200, "empty response");
        return list[0];
    }

    /// <summary>
    /// Flip the session to ended. Teardown is fire-and-forget at the call
    /// site, so a swallowed non-2xx here used to leave the row live forever:
    /// the device stayed is_session_active, the agent kept pumping pixels and
    /// the next connect reused a zombie session. Retry three times with a
    /// short backoff and record the failure in admin.log either way.
    /// </summary>
    public async Task EndSessionAsync(string sessionId, CancellationToken ct)
    {
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                using var req = NewSupabase(new HttpMethod("PATCH"), $"/rest/v1/sessions?id=eq.{Uri.EscapeDataString(sessionId)}");
                req.Content = JsonContent.Create(new { state = "ended", ended_at = DateTime.UtcNow });
                using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
                if (res.IsSuccessStatusCode) return;
                var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                Diag.Log.Write($"[session] end attempt {attempt} failed {(int)res.StatusCode}: {body}");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                Diag.Log.Write($"[session] end attempt {attempt} threw: {ex.Message}");
            }
            if (attempt < 3)
            {
                try { await Task.Delay(400 * attempt, ct).ConfigureAwait(false); } catch { return; }
            }
        }
        Diag.Log.Write($"[session] end GAVE UP for {sessionId} — row may stay live until prune_session_ephemera");
    }


    public async Task SetSessionModeAsync(string sessionId, string mode, CancellationToken ct)
    {
        using var req = NewSupabase(new HttpMethod("PATCH"), $"/rest/v1/sessions?id=eq.{Uri.EscapeDataString(sessionId)}");
        req.Content = JsonContent.Create(new { mode });
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "set session mode", ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Re-arm an existing session so a woken agent rejoins it instead of
    /// waiting for a fresh invite. Mirrors the web console's requestReconnect.
    /// </summary>
    public async Task ResumeSessionAsync(string sessionId, CancellationToken ct)
    {
        using var req = NewSupabase(new HttpMethod("PATCH"), $"/rest/v1/sessions?id=eq.{Uri.EscapeDataString(sessionId)}");
        req.Content = JsonContent.Create(new { state = "active", mode = "view", updated_at = DateTime.UtcNow });
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "resume session", ct).ConfigureAwait(false);
    }


    // Push an input event (mouse/keyboard/text/curtain) that the agent will pick up.
    public async Task PushInputAsync(string sessionId, string kind, object payload, CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Post, "/rest/v1/session_inputs");
        req.Content = JsonContent.Create(new
        {
            session_id = sessionId,
            kind,
            payload,
        });
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "push input", ct).ConfigureAwait(false);
    }

    /// <summary>
    /// S11 — render telemetry. One row per minute per live console: what the
    /// technician actually saw (fps, latency, queue, drops, present path) plus
    /// how it got there (input transport, wire path, ICE restarts, peer state).
    /// Best-effort: telemetry must never disturb a live session, so failures
    /// are swallowed by the caller.
    /// </summary>
    public async Task PushTelemetryAsync(string sessionId, object row, CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Post, "/rest/v1/session_telemetry");
        req.Content = JsonContent.Create(row);
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "push telemetry", ct).ConfigureAwait(false);
    }

    // Send a WebRTC signal (SDP or ICE) that the agent will poll.
    // admin_client_id is stamped so the agent can tell which physical admin
    // box owns the current negotiation and can supersede stale ones.
    // attempt_id makes the write idempotent against the ux_session_signals_attempt
    // unique index so the reliable-retry wrapper below never double-inserts.
    public async Task<int> PushSignalAsync(string sessionId, string kind, object payload, CancellationToken ct, string? attemptId = null)
    {
        if (string.IsNullOrEmpty(App.ClientId))
            throw new InvalidOperationException("Admin ClientId is not initialised; cannot push signal.");
        using var req = NewSupabase(HttpMethod.Post, "/rest/v1/session_signals");
        var body = new System.Collections.Generic.Dictionary<string, object?>
        {
            ["session_id"] = sessionId,
            ["from_side"] = "admin",
            ["kind"] = kind,
            ["payload"] = payload,
            ["admin_client_id"] = App.ClientId,
        };
        if (attemptId != null) body["attempt_id"] = attemptId;
        req.Content = JsonContent.Create(body);
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        // 23505 (unique_violation on attempt_id) surfaces as PostgREST 409 —
        // treat as success so callers can safely retry the same attempt_id.
        if ((int)res.StatusCode == 409) return 200;
        await EnsureOkAsync(res, "push signal", ct).ConfigureAwait(false);
        return (int)res.StatusCode;
    }

    // Reliable variant: FIFO per session with bounded exponential backoff.
    // Guarantees that an ICE candidate cannot overtake the answer it depends
    // on if the network hiccups mid-negotiation.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> _signalGates = new();

    public async Task PushSignalReliableAsync(string sessionId, string kind, object payload, CancellationToken ct)
    {
        var attempt = "adm-" + Guid.NewGuid().ToString("N").Substring(0, 12);
        var gate = _signalGates.GetOrAdd(sessionId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            for (int i = 0; i < 6; i++)
            {
                try
                {
                    await PushSignalAsync(sessionId, kind, payload, ct, attempt).ConfigureAwait(false);
                    return;
                }
                catch (SupabaseCallException ex) when (ex.StatusCode == 400 || ex.StatusCode == 401 || ex.StatusCode == 403 || ex.StatusCode == 404 || ex.StatusCode == 413)
                {
                    // Hard errors — do not retry.
                    throw;
                }
                catch
                {
                    var backoff = Math.Min(4000, 250 * (int)Math.Pow(2, i));
                    try { await Task.Delay(backoff, ct); } catch { return; }
                }
            }
        }
        finally { gate.Release(); }
    }

    // Heartbeat / take-over via bind_admin RPC.
    // Returns (bound, reason) — reason == "superseded" means another admin
    // console owns this session and the UI should close the live window.
    public async Task<(bool bound, string reason, string? adminClientId)> BindAdminAsync(string sessionId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(App.ClientId))
            throw new InvalidOperationException("Admin ClientId is not initialised.");
        using var req = NewSupabase(HttpMethod.Post, "/rest/v1/rpc/bind_admin");
        req.Content = JsonContent.Create(new { _session_id = sessionId, _client_id = App.ClientId });
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) return (false, "rpc_error", null);
        var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        var row = doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0
            ? doc.RootElement[0]
            : doc.RootElement;
        var bound = row.TryGetProperty("bound", out var b) && b.ValueKind == JsonValueKind.True;
        var reason = row.TryGetProperty("reason", out var r) ? (r.GetString() ?? "") : "";
        var acid = row.TryGetProperty("admin_client_id", out var a) && a.ValueKind == JsonValueKind.String ? a.GetString() : null;
        return (bound, reason, acid);
    }

    // Poll agent-originated signals. We only pick up rows that either
    //   (a) target THIS admin machine (admin_client_id = ours), or
    //   (b) are un-targeted broadcasts (admin_client_id IS NULL),
    // so a second admin box never steals our answer/ICE/terminated packets.
    public async Task<(long max, List<SessionSignal> items)> PollAgentSignalsAsync(string sessionId, long since, CancellationToken ct)
    {
        var clientFilter = $"or=(admin_client_id.eq.{Uri.EscapeDataString(App.ClientId)},admin_client_id.is.null)";
        using var req = NewSupabase(HttpMethod.Get,
            $"/rest/v1/session_signals?select=id,from_side,kind,payload,admin_client_id&session_id=eq.{Uri.EscapeDataString(sessionId)}&from_side=eq.agent&id=gt.{since}&{clientFilter}&order=id.asc&limit=100");
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "poll signals", ct).ConfigureAwait(false);
        var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        var list = await JsonSerializer.DeserializeAsync<List<SessionSignal>>(stream, cancellationToken: ct)
                   ?? new List<SessionSignal>();
        long max = list.Count > 0 ? list[^1].Id : since;
        return (max, list);
    }

    // Poll latest frame bytes for a session as fallback when WebRTC hasn't
    // linked yet.
    //
    // `since` is the updated_at stamp of the frame we already hold. Passing it
    // adds an `updated_at=gt.` filter so PostgREST returns an EMPTY array when
    // the agent hasn't produced anything new — instead of us re-downloading
    // the same ~100 KB base64 JPEG five times a second, which was starving the
    // link and making the stream look laggy/stalled.
    public sealed record FrameSample(byte[] Bytes, string UpdatedAt);

    public async Task<FrameSample?> GetLatestFrameAsync(string sessionId, string? since, CancellationToken ct)
    {
        var filter = string.IsNullOrEmpty(since)
            ? ""
            : $"&updated_at=gt.{Uri.EscapeDataString(since)}";
        using var req = NewSupabase(HttpMethod.Get,
            $"/rest/v1/session_frames?select=frame,updated_at&session_id=eq.{Uri.EscapeDataString(sessionId)}{filter}&order=updated_at.desc&limit=1");
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "poll frames", ct).ConfigureAwait(false);
        var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        if (doc.RootElement.GetArrayLength() == 0) return null;
        var row = doc.RootElement[0];
        var b64 = row.GetProperty("frame").GetString();
        if (string.IsNullOrEmpty(b64)) return null;
        var stamp = row.TryGetProperty("updated_at", out var u) ? (u.GetString() ?? "") : "";
        try { return new FrameSample(Convert.FromBase64String(b64), stamp); } catch { return null; }
    }

    // Poll latest cursor telemetry so the native admin can render a ghost
    // pointer over the D3D surface — same source the web console uses.
    // Same `since` short-circuit as frames.
    public sealed record CursorSample(int X, int Y, int? FrameW, int? FrameH, string Kind, bool Visible, string UpdatedAt);

    public async Task<CursorSample?> PollSessionCursorAsync(string sessionId, string? since, CancellationToken ct)
    {
        var filter = string.IsNullOrEmpty(since)
            ? ""
            : $"&updated_at=gt.{Uri.EscapeDataString(since)}";
        using var req = NewSupabase(HttpMethod.Get,
            $"/rest/v1/session_cursors?select=x,y,frame_w,frame_h,kind,visible,updated_at&session_id=eq.{Uri.EscapeDataString(sessionId)}{filter}&order=updated_at.desc&limit=1");
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "poll cursor", ct).ConfigureAwait(false);
        var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        if (doc.RootElement.GetArrayLength() == 0) return null;
        var row = doc.RootElement[0];
        return new CursorSample(
            row.GetProperty("x").GetInt32(),
            row.GetProperty("y").GetInt32(),
            row.TryGetProperty("frame_w", out var fw) && fw.ValueKind == JsonValueKind.Number ? fw.GetInt32() : null,
            row.TryGetProperty("frame_h", out var fh) && fh.ValueKind == JsonValueKind.Number ? fh.GetInt32() : null,
            row.TryGetProperty("kind", out var k) ? (k.GetString() ?? "arrow") : "arrow",
            row.TryGetProperty("visible", out var v) && v.ValueKind == JsonValueKind.True,
            row.TryGetProperty("updated_at", out var cu) ? (cu.GetString() ?? "") : "");
    }


    // Queue a power-management command (shutdown / restart / lock / logoff /
    // wake) for the agent's PowerRelay to pick up. RLS restricts inserts to
    // authenticated staff with the admin/super_admin role.
    public Task EnqueuePowerCommandAsync(string deviceRowId, string kind, object? payload, CancellationToken ct)
        => EnqueuePowerCommandAsync(deviceRowId, kind, payload, null, ct);

    public async Task EnqueuePowerCommandAsync(string deviceRowId, string kind, object? payload, string? relayDeviceId, CancellationToken ct)
    {
        // Older UI builds used "restart" while the database and Agent use
        // "reboot". Normalize at the API boundary so stale callers cannot
        // trigger power_commands_kind_check again.
        if (string.Equals(kind, "restart", StringComparison.OrdinalIgnoreCase))
            kind = "reboot";
        using var req = NewSupabase(HttpMethod.Post, "/rest/v1/power_commands");
        req.Headers.Add("Prefer", "return=minimal");
        var body = new System.Collections.Generic.Dictionary<string, object?>
        {
            ["device_id"] = deviceRowId,
            ["kind"] = kind,
            ["payload"] = payload ?? new { },
            ["state"] = "queued",
            ["expires_at"] = DateTime.UtcNow.AddMinutes(5),
            ["requested_by"] = _auth.Current?.UserId,
        };
        if (!string.IsNullOrEmpty(relayDeviceId)) body["relay_device_id"] = relayDeviceId;
        req.Content = JsonContent.Create(body);
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "enqueue power command", ct).ConfigureAwait(false);
    }

    // ---------- JWT helpers ----------

    private static long DecodeJwtExpiry(string jwt)
    {
        try
        {
            var parts = jwt.Split('.');
            if (parts.Length < 2) return 0;
            var payload = Base64UrlDecode(parts[1]);
            using var doc = JsonDocument.Parse(payload);
            if (doc.RootElement.TryGetProperty("exp", out var exp)) return exp.GetInt64();
        }
        catch { }
        return 0;
    }

    private static string DecodeJwtSubject(string jwt)
    {
        try
        {
            var parts = jwt.Split('.');
            if (parts.Length < 2) return "";
            var payload = Base64UrlDecode(parts[1]);
            using var doc = JsonDocument.Parse(payload);
            if (doc.RootElement.TryGetProperty("sub", out var sub)) return sub.GetString() ?? "";
        }
        catch { }
        return "";
    }

    private static byte[] Base64UrlDecode(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4) { case 2: s += "=="; break; case 3: s += "="; break; }
        return Convert.FromBase64String(s);
    }
}
