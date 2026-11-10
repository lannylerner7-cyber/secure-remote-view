using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

public sealed partial class ApiClient
{
    /// <summary>Read only this live session/controller/grant/process's current mode.
    /// Does not establish or extend the Agent's heartbeat authority.</summary>
    internal async Task<bool> ConfirmSessionModeAsync(
        string sessionId, string mode, string controllerId, CancellationToken ct)
    {
        var grant = LocalAuthorization?.Authorization.Id;
        if (grant == null || (mode != "view" && mode != "control")) return false;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(5));
        var path = $"/api/public/agent/session/{Uri.EscapeDataString(sessionId)}/permission" +
            $"?mode={mode}&authorization_id={Uri.EscapeDataString(grant)}" +
            $"&admin_client_id={Uri.EscapeDataString(controllerId)}&instance={AgentProcessState.Instance}";
        try
        {
            using var response = await SendAuthedAsync(
                () => new HttpRequestMessage(HttpMethod.Get, path), budget.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                Log.Warn($"permission refresh rejected: HTTP {(int)response.StatusCode}");
                return false;
            }
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(budget.Token).ConfigureAwait(false));
            var value = body.RootElement;
            return !budget.IsCancellationRequested && LocalAuthorization?.Authorization.Id == grant &&
                value.GetProperty("protocol").GetInt32() == 1 &&
                value.GetProperty("sessionId").GetString() == sessionId &&
                value.GetProperty("authorizationId").GetString() == grant &&
                value.GetProperty("adminClientId").GetString() == controllerId &&
                value.GetProperty("mode").GetString() == mode;
        }
        catch (Exception ex)
        {
            Log.Warn($"permission refresh unavailable: {AgentHttpDiagnostics.SafeFailure(ex, ct.IsCancellationRequested)}");
            return false;
        }
    }
}
