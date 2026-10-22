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

    /// <summary>
    /// Raised on the renewal thread whenever the access token rotates, with
    /// the new token. Long-lived sockets (Realtime) subscribe so they can
    /// re-auth in place instead of dying when the old token expires.
    /// </summary>
    public event Action<string>? TokenChanged;

    private CancellationTokenSource? _renewCts;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);

    public ApiClient(AppConfig config, AuthStore auth)
    {
        config.Validate();
        _config = config;
        _auth = auth;
        _http = new HttpClient(ConnectLive.Native.NativeGatewayPolicy.CreateHandler())
            { Timeout = TimeSpan.FromSeconds(20) };
    }

    /// <summary>Current technician access token, or null when signed out.</summary>
    public string? AccessToken
        => string.IsNullOrEmpty(_auth.Current?.AccessToken) ? null : _auth.Current!.AccessToken;

    public async Task<bool> CanRecordSessionAsync(string sessionId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(AccessToken)) return false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"{_config.BaseUrl}/api/public/admin/session/{Uri.EscapeDataString(sessionId)}/authorization");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AccessToken);
            using var res = await _http.SendAsync(req, timeout.Token).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode) return false;
            using var doc = await JsonDocument.ParseAsync(
                await res.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false),
                cancellationToken: timeout.Token).ConfigureAwait(false);
            var root = doc.RootElement;
            return root.TryGetProperty("allowed", out var allowed) && allowed.ValueKind == JsonValueKind.True
                && root.TryGetProperty("authorizationId", out var id) && id.ValueKind == JsonValueKind.String
                && Guid.TryParse(id.GetString(), out _)
                && root.TryGetProperty("capabilities", out var scopes)
                && scopes.TryGetProperty("recording", out var recording) && recording.ValueKind == JsonValueKind.True;
        }
        catch { return false; }
    }

    /// <summary>
    /// Background renewal. Supabase access tokens live about an hour; nothing
    /// used to renew them proactively, so any console session that outlived the
    /// token lost Realtime permanently ("Token has expired N seconds ago") and
    /// fell back to HTTP polling for the rest of the session. This keeps the
    /// token at least 60s ahead of expiry, forever, on one cheap timer.
    /// </summary>
    public void StartTokenRenewal()
    {
        StopTokenRenewal();
        var cts = new CancellationTokenSource();
        _renewCts = cts;
        var ct = cts.Token;
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                TimeSpan wait;
                try
                {
                    var s = _auth.Current;
                    if (s == null || string.IsNullOrEmpty(s.RefreshToken))
                    {
                        wait = TimeSpan.FromSeconds(30);
                    }
                    else
                    {
                        var secondsLeft = s.ExpiresAt - DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                        if (secondsLeft <= 60)
                        {
                            var ok = await EnsureFreshTokenAsync(ct).ConfigureAwait(false);
                            wait = ok ? TimeSpan.FromSeconds(15) : TimeSpan.FromSeconds(20);
                        }
                        else
                        {
                            // Wake shortly before the 60s threshold.
                            wait = TimeSpan.FromSeconds(Math.Min(300, Math.Max(15, secondsLeft - 60)));
                        }
                    }
                }
                catch { wait = TimeSpan.FromSeconds(30); }

                try { await Task.Delay(wait, ct).ConfigureAwait(false); } catch { return; }
            }
        }, CancellationToken.None);
    }

    public void StopTokenRenewal()
    {
        try { _renewCts?.Cancel(); } catch { }
        _renewCts = null;
    }

    /// <summary>
    /// True when there is no usable token, or the one we hold falls inside the
    /// given expiry window. Callers about to open a long-lived socket use this
    /// to renew *before* the join rather than eating a guaranteed rejection —
    /// the exact case a laptop hits on resume, where the socket reconnects
    /// before the renewal timer thread wakes up.
    /// </summary>
    public bool TokenExpiringWithin(int seconds)
    {
        var s = _auth.Current;
        if (s == null || string.IsNullOrEmpty(s.AccessToken)) return true;
        return s.ExpiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds() + seconds;
    }

    /// <summary>
    /// Refresh the token if it is expired or nearly so. Serialised, so a burst
    /// of 401 retries plus the renewal timer produce one refresh, not five
    /// (each of which would invalidate the previous refresh token).
    /// </summary>
    public async Task<bool> EnsureFreshTokenAsync(CancellationToken ct)
    {
        await _refreshGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var s = _auth.Current;
            if (s != null && !string.IsNullOrEmpty(s.AccessToken)
                && s.ExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60)
                return true;   // someone else already refreshed while we waited
            return await RefreshSessionAsync(ct).ConfigureAwait(false);
        }
        finally { _refreshGate.Release(); }
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
        // Tell the live sockets before anything else touches the wire.
        try { TokenChanged?.Invoke(access); } catch { }
        return true;
    }

    public void Logout()
    {
        StopTokenRenewal();
        _auth.Clear();
    }

    // ---------- ICE gateway (S9) ----------

    public sealed record IceServerInfo(List<string> Urls, string? Username, string? Credential);

    /// <summary>
    /// Fetch the ICE set from /api/public/agent/ice using the technician JWT.
    /// Returns an empty list on gateway outages so the caller keeps its STUN
    /// fallback. Cancellation and authorization denial propagate to negotiation.
    /// </summary>
    public async Task<List<IceServerInfo>> GetIceServersAsync(string sessionId, CancellationToken ct)
    {
        var result = new List<IceServerInfo>();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get,
                _config.BaseUrl + ConnectLive.Native.NativeGatewayPolicy.IcePath(sessionId));
            if (_auth.Current != null && !string.IsNullOrEmpty(_auth.Current.AccessToken))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.Current.AccessToken);
            using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (res.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden)
                throw new UnauthorizedAccessException("ICE authorization was rejected. Sign in and reconnect to a session you own.");
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
        catch (OperationCanceledException) { throw; }
        catch (UnauthorizedAccessException) { throw; }
        catch { /* gateway outage: fallback to STUN */ }
        return result;
    }


    // ---------- Release manifest (S14) ----------

    public sealed record ReleaseInfo(
        string Product, string Channel, string Version,
        string DownloadUrl, string? Sha256, string? Notes, bool Mandatory);

    /// <summary>
    /// Newest published build for a product/channel, or null when nothing is
    /// published (204) or the call fails. Used for the console's own update
    /// banner and to tell the technician which agent zip the fleet expects.
    /// Never throws — an update check must not break the device list.
    /// </summary>
    public async Task<ReleaseInfo?> GetReleaseAsync(string product, string channel, CancellationToken ct)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"{_config.BaseUrl}/api/public/agent/release?product={product}&channel={channel}");
            if (_auth.Current != null && !string.IsNullOrEmpty(_auth.Current.AccessToken))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.Current.AccessToken);
            using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode || res.StatusCode == System.Net.HttpStatusCode.NoContent) return null;
            var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(body)) return null;
            using var doc = JsonDocument.Parse(body);
            var r = doc.RootElement;
            string? Str(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var version = Str("version");
            var url = Str("download_url");
            if (string.IsNullOrWhiteSpace(version) || string.IsNullOrWhiteSpace(url)) return null;
            return new ReleaseInfo(
                Str("product") ?? product,
                Str("channel") ?? channel,
                version!, url!, Str("sha256"), Str("notes"),
                r.TryGetProperty("mandatory", out var m) && m.ValueKind == JsonValueKind.True);
        }
        catch { return null; }
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
        // Transport recovery never grants consent or reopens paused/closed rows.
        using var req = NewSupabase(new HttpMethod("PATCH"), $"/rest/v1/sessions?id=eq.{Uri.EscapeDataString(sessionId)}&state=eq.active");
        req.Headers.TryAddWithoutValidation("Prefer", "return=representation");
        req.Content = JsonContent.Create(new { mode = "view", updated_at = DateTime.UtcNow });
        using var res = await SendSupabaseAsync(req, ct).ConfigureAwait(false);
        await EnsureOkAsync(res, "resume session", ct).ConfigureAwait(false);
        using var body = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
        if (body.RootElement.ValueKind != JsonValueKind.Array || body.RootElement.GetArrayLength() != 1)
            throw new InvalidOperationException("Session is no longer active or accessible. Start a new authorized session.");
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

    // Step 9 — native-admin file transfer. These mirror the web console's
    // session-files server functions, exposed as stable HTTP so the C#
    // console can call them with the technician's Supabase JWT.

    private HttpRequestMessage NewAdminRoute(HttpMethod method, string sessionId, string action)
    {
        var req = new HttpRequestMessage(method, $"{_config.BaseUrl}/api/public/admin/session/{Uri.EscapeDataString(sessionId)}/files");
        req.Headers.Add("Accept", "application/json");
        req.Headers.Add("x-action", action);
        if (_auth.Current != null && !string.IsNullOrEmpty(_auth.Current.AccessToken))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.Current.AccessToken);
        return req;
    }

    public async Task<SessionFilesList> ListSessionFilesAsync(string sessionId, CancellationToken ct)
    {
        using var req = NewAdminRoute(HttpMethod.Get, sessionId, "list");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode || string.IsNullOrWhiteSpace(body))
            return new SessionFilesList { Error = $"list failed {(int)res.StatusCode}" };
        return JsonSerializer.Deserialize<SessionFilesList>(body) ?? new SessionFilesList { Error = "bad json" };
    }

    public async Task<PrepareUploadResponse> PrepareSessionUploadAsync(string sessionId, string name, long size, CancellationToken ct)
    {
        using var req = NewAdminRoute(HttpMethod.Post, sessionId, "prepare");
        req.Content = JsonContent.Create(new { name, size });
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode || string.IsNullOrWhiteSpace(body))
            return new PrepareUploadResponse { Error = $"prepare failed {(int)res.StatusCode}: {body}" };
        return JsonSerializer.Deserialize<PrepareUploadResponse>(body) ?? new PrepareUploadResponse { Error = "bad json" };
    }

    public async Task UploadToSignedUrlAsync(string signedUrl, System.IO.Stream stream, string mime, CancellationToken ct)
    {
        // Keep the method/DTO name for existing callers. The value is now a
        // same-origin identifier-only proxy URL, never a signed bearer URL.
        using var req = NewFileByteRequest(HttpMethod.Put, signedUrl);
        req.Content = new StreamContent(stream);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue(mime);
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
            { Timeout = TimeSpan.FromMinutes(10) };
        using var res = await client.SendAsync(req, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
    }

    private HttpRequestMessage NewFileByteRequest(HttpMethod method, string proxyUrl)
    {
        var origin = new Uri(_config.BaseUrl.TrimEnd('/') + "/");
        var target = new Uri(origin, proxyUrl);
        if (target.Scheme != origin.Scheme || target.Host != origin.Host || target.Port != origin.Port ||
            !System.Text.RegularExpressions.Regex.IsMatch(target.AbsolutePath,
                @"^/api/public/admin/session/[^/]+/files/bytes$") ||
            !string.IsNullOrEmpty(target.UserInfo) || !string.IsNullOrEmpty(target.Fragment))
            throw new InvalidOperationException("Invalid authenticated file proxy URL.");
        foreach (var part in target.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var key = Uri.UnescapeDataString(part.Split('=')[0]);
            if (key != "path" && key != "fileId" && key != "fileIds")
                throw new InvalidOperationException("Unexpected file proxy query parameter.");
        }
        var jwt = _auth.Current?.AccessToken;
        if (string.IsNullOrEmpty(jwt)) throw new InvalidOperationException("File transfer requires authentication.");
        var req = new HttpRequestMessage(method, target);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        return req;
    }

    private async Task<string> DownloadFileProxyAsync(string url, CancellationToken ct)
    {
        using var req = NewFileByteRequest(HttpMethod.Get, url);
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
            { Timeout = TimeSpan.FromMinutes(10) };
        using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        var directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ConnectLive");
        System.IO.Directory.CreateDirectory(directory);
        var local = System.IO.Path.Combine(directory, $"connectlive-files-{Guid.NewGuid():N}.zip");
        try
        {
            await using var input = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await using var output = new System.IO.FileStream(local, System.IO.FileMode.CreateNew,
                System.IO.FileAccess.Write, System.IO.FileShare.None);
            await input.CopyToAsync(output, ct).ConfigureAwait(false);
            return local;
        }
        catch
        {
            try { System.IO.File.Delete(local); } catch { }
            throw;
        }
    }

    public async Task<bool> RegisterSessionFileAsync(string sessionId, string path, string name, long size,
        string mime, string sha256, string direction, string transport, CancellationToken ct)
    {
        using var req = NewAdminRoute(HttpMethod.Post, sessionId, "register");
        req.Content = JsonContent.Create(new { path, name, size, mime, sha256, direction, transport });
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException($"File registration failed {(int)res.StatusCode}: " +
                await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
        return true;
    }

    public async Task<PackageFilesResponse> RequestZipAsync(string sessionId, List<string> fileIds, CancellationToken ct)
    {
        using var req = NewAdminRoute(HttpMethod.Post, sessionId, "package");
        req.Content = JsonContent.Create(new { fileIds });
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode || string.IsNullOrWhiteSpace(body))
            return new PackageFilesResponse { Error = $"package failed {(int)res.StatusCode}: {body}" };
        var result = JsonSerializer.Deserialize<PackageFilesResponse>(body) ?? new PackageFilesResponse { Error = "bad json" };
        if (result.Ok && !string.IsNullOrEmpty(result.Url))
        {
            // The existing view opens Url with the OS shell, which cannot attach
            // JWT headers. Download here first and return a local encrypted file.
            try { result.Url = await DownloadFileProxyAsync(result.Url, ct).ConfigureAwait(false); }
            catch (Exception ex) { return new PackageFilesResponse { Error = "Authenticated archive download failed: " + ex.Message }; }
        }
        return result;
    }

    public async Task<bool> SubmitSessionPasswordAsync(string sessionId, string email, string password, CancellationToken ct)
    {
        using var req = NewAdminRoute(HttpMethod.Post, sessionId, "password");
        req.Content = JsonContent.Create(new { email, password });
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        return res.IsSuccessStatusCode;
    }

    public async Task<bool> DeleteSessionFileAsync(string sessionId, string fileId, CancellationToken ct)
    {
        using var req = NewAdminRoute(HttpMethod.Delete, sessionId, "delete");
        req.Content = JsonContent.Create(new { fileId });
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        return res.IsSuccessStatusCode;
    }

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
