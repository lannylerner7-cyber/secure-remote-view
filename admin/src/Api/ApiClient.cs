using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
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
        using var res = await _http.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
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
        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) return false;
        var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
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
        var res = await _http.SendAsync(req, ct);
        if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            res.Dispose();
            if (await RefreshSessionAsync(ct))
            {
                var clone = await CloneAsync(req);
                if (clone.Headers.Authorization != null && _auth.Current != null)
                    clone.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.Current.AccessToken);
                return await _http.SendAsync(clone, ct);
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
            var s = await req.Content.ReadAsStringAsync();
            clone.Content = new StringContent(s, Encoding.UTF8, req.Content.Headers.ContentType?.MediaType ?? "application/json");
        }
        return clone;
    }

    public async Task<List<DeviceRow>> ListDevicesAsync(CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Get,
            "/rest/v1/devices?select=id,device_id,display_name,hostname,os,last_seen_at,status,is_session_active&order=last_seen_at.desc");
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "list devices", ct);
        var stream = await res.Content.ReadAsStreamAsync(ct);
        return await JsonSerializer.DeserializeAsync<List<DeviceRow>>(stream, cancellationToken: ct)
               ?? new List<DeviceRow>();
    }

    public async Task DeleteDeviceAsync(string deviceRowId, CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Delete, $"/rest/v1/devices?id=eq.{Uri.EscapeDataString(deviceRowId)}");
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "delete device", ct);
    }

    public async Task<SessionRow> CreateSessionAsync(string deviceRowId, string mode, CancellationToken ct)
    {
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
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "create session", ct);
        var stream = await res.Content.ReadAsStreamAsync(ct);
        var list = await JsonSerializer.DeserializeAsync<List<SessionRow>>(stream, cancellationToken: ct);
        if (list == null || list.Count == 0)
            throw new SupabaseCallException("create session", 200, "empty response");
        return list[0];
    }

    public async Task EndSessionAsync(string sessionId, CancellationToken ct)
    {
        using var req = NewSupabase(new HttpMethod("PATCH"), $"/rest/v1/sessions?id=eq.{Uri.EscapeDataString(sessionId)}");
        req.Content = JsonContent.Create(new { state = "ended", ended_at = DateTime.UtcNow });
        using var res = await SendSupabaseAsync(req, ct);
        _ = res.IsSuccessStatusCode; // best-effort on teardown
    }

    public async Task SetSessionModeAsync(string sessionId, string mode, CancellationToken ct)
    {
        using var req = NewSupabase(new HttpMethod("PATCH"), $"/rest/v1/sessions?id=eq.{Uri.EscapeDataString(sessionId)}");
        req.Content = JsonContent.Create(new { mode });
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "set session mode", ct);
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
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "push input", ct);
    }

    // Send a WebRTC signal (SDP or ICE) that the agent will poll.
    // admin_client_id is stamped so the agent can tell which physical admin
    // box owns the current negotiation and can supersede stale ones.
    public async Task PushSignalAsync(string sessionId, string kind, object payload, CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Post, "/rest/v1/session_signals");
        req.Content = JsonContent.Create(new
        {
            session_id = sessionId,
            from_side = "admin",
            kind,
            payload,
            admin_client_id = App.ClientId,
        });
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "push signal", ct);
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
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "poll signals", ct);
        var stream = await res.Content.ReadAsStreamAsync(ct);
        var list = await JsonSerializer.DeserializeAsync<List<SessionSignal>>(stream, cancellationToken: ct)
                   ?? new List<SessionSignal>();
        long max = list.Count > 0 ? list[^1].Id : since;
        return (max, list);
    }

    // Poll latest frame bytes for a session as fallback when WebRTC hasn't linked yet.
    public async Task<byte[]?> GetLatestFrameAsync(string sessionId, CancellationToken ct)
    {
        using var req = NewSupabase(HttpMethod.Get,
            $"/rest/v1/session_frames?select=frame,updated_at&session_id=eq.{Uri.EscapeDataString(sessionId)}&order=updated_at.desc&limit=1");
        using var res = await SendSupabaseAsync(req, ct);
        await EnsureOkAsync(res, "poll frames", ct);
        var stream = await res.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        if (doc.RootElement.GetArrayLength() == 0) return null;
        var b64 = doc.RootElement[0].GetProperty("frame").GetString();
        if (string.IsNullOrEmpty(b64)) return null;
        try { return Convert.FromBase64String(b64); } catch { return null; }
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
