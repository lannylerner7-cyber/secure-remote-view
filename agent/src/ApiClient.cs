using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Thin HTTP + WebSocket client for the ConnectLive gateway.
/// Routes mirror the OpenAPI contract:
///   POST /api/devices/enroll      -> { deviceId, deviceToken }
///   POST /api/devices/heartbeat   -> 204 (auth: X-Device-Token)
///   WS   /api/ws?token=...        -> session invites, signaling, control
/// </summary>
public sealed class ApiClient
{
    // Override at build time or via first-run --api-url flag.
    public const string DefaultApiBaseUrl = "https://helpdesk.example.com";

    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ConnectLive");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");
    private static readonly string DevicePath = Path.Combine(ConfigDir, "device.dat");

    private readonly HttpClient _http;
    public string ApiBaseUrl { get; }
    public string? DeviceId { get; private set; }
    public string? DeviceToken { get; private set; }

    public ApiClient(string? overrideBaseUrl = null)
    {
        Directory.CreateDirectory(ConfigDir);
        ApiBaseUrl = overrideBaseUrl ?? LoadConfig()?.ApiBaseUrl ?? DefaultApiBaseUrl;
        _http = new HttpClient { BaseAddress = new Uri(ApiBaseUrl), Timeout = TimeSpan.FromSeconds(20) };
        LoadDeviceCreds();
    }

    // ---- Enrollment ----------------------------------------------------

    public async Task EnrollIfNeededAsync(CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(DeviceToken)) return;

        var payload = new
        {
            hostname = Environment.MachineName,
            osVersion = Environment.OSVersion.VersionString,
            agentVersion = typeof(ApiClient).Assembly.GetName().Version?.ToString() ?? "1.0.0"
        };
        using var resp = await _http.PostAsJsonAsync("/api/devices/enroll", payload, ct);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadFromJsonAsync<EnrollResponse>(cancellationToken: ct)
                   ?? throw new InvalidOperationException("Empty enrollment response");

        DeviceId = body.DeviceId;
        DeviceToken = body.DeviceToken;
        SaveDeviceCreds(body);
    }

    public async Task HeartbeatAsync(CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/devices/heartbeat");
        req.Headers.Add("X-Device-Token", DeviceToken);
        using var resp = await _http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();
    }

    // ---- Realtime WebSocket -------------------------------------------

    public async Task<ClientWebSocket> ConnectRealtimeAsync(CancellationToken ct)
    {
        var uri = new Uri(new Uri(ApiBaseUrl.Replace("https://", "wss://").Replace("http://", "ws://")),
                          $"/api/ws?token={Uri.EscapeDataString(DeviceToken!)}");
        var ws = new ClientWebSocket();
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        await ws.ConnectAsync(uri, ct);
        return ws;
    }

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

    private static AgentConfig? LoadConfig() =>
        File.Exists(ConfigPath) ? JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(ConfigPath)) : null;

    public static void SaveConfig(AgentConfig cfg) =>
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(cfg));

    // ---- DTOs ----------------------------------------------------------

    public sealed record EnrollResponse(string DeviceId, string DeviceToken);
    public sealed record AgentConfig(string ApiBaseUrl);
}
