using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>Fresh server-grant check for recovery; credentials never leave the recorded HTTPS origin.</summary>
internal static class CompanionAuthorization
{
    internal static HttpRequestMessage? Request(string path, HttpMethod method, bool requireStartup = true)
    {
        var grant = GrantStore.Load();
        if (grant == null || (requireStartup && !StartupConsent.IsAllowed()) ||
            !Uri.TryCreate(grant.Origin, UriKind.Absolute, out var origin) || origin.Scheme != "https" ||
            !string.IsNullOrEmpty(origin.UserInfo) || !string.IsNullOrEmpty(origin.Query) ||
            !string.IsNullOrEmpty(origin.Fragment) || origin.AbsolutePath != "/") return null;
        var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ConnectLive", "device.dat");
        var credentials = JsonSerializer.Deserialize<StoredCreds>(
            ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.LocalMachine));
        if (credentials == null || credentials.DeviceId != grant.DeviceId ||
            string.IsNullOrWhiteSpace(credentials.DeviceToken)) return null;
        var request = new HttpRequestMessage(method, new Uri(origin, path));
        request.Headers.Add("X-Device-Id", credentials.DeviceId);
        request.Headers.Add("X-Device-Token", credentials.DeviceToken);
        return request;
    }

    internal static async Task<bool> MayRestartAsync(string reason, CancellationToken cancellation)
    {
        var grant = GrantStore.Load();
        using var request = Request("/api/public/agent/beacon", HttpMethod.Post);
        if (grant == null || request == null) return false;
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(10) };
        request.Content = new StringContent(JsonSerializer.Serialize(new
        { reason, authorizationId = grant.Authorization.Id }), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, cancellation);
        if (!response.IsSuccessStatusCode) return false;
        using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
        return StartupConsent.IsAllowed() &&
            result.RootElement.TryGetProperty("restart_authorized", out var allowed) &&
            allowed.ValueKind == JsonValueKind.True;
    }

    internal static async Task ReportWithdrawalAsync(bool removing, CancellationToken cancellation)
    {
        var grant = GrantStore.Load();
        using var request = Request("/api/public/agent/watch", HttpMethod.Post, requireStartup: false);
        if (grant == null || request == null) return;
        request.Content = new StringContent(JsonSerializer.Serialize(new {
            instance = Guid.NewGuid().ToString("D"), sequence = 1,
            authorization_id = grant.Authorization.Id,
            agent_instance = AgentProcessState.Read()?.Instance, startup_enabled = false,
            state = removing ? "uninstalling" : "disabled",
            detail_code = removing ? "uninstall_requested" : "local_withdrawal",
        }), Encoding.UTF8, "application/json");
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(3) };
        using var response = await http.SendAsync(request, cancellation);
        response.EnsureSuccessStatusCode();
    }

    private sealed record StoredCreds(string DeviceId, string DeviceToken);
}
