using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

public sealed partial class ApiClient
{
    internal async Task<bool> FileReceiptAsync(ToolBinding binding, VerifiedFileInfo info, string direction, bool complete, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            if (!await ConfirmToolAuthorityAsync(binding, "files", deadline.Token)) return false;
            using var response = await SendAuthedAsync(() => {
                var request = new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/session/{binding.sessionId}/file?fileId={info.id}");
                request.Headers.Add("x-file-action", complete ? "receipt" : "reserve");
                request.Headers.Add("x-file-name", Uri.EscapeDataString(info.name));
                request.Headers.Add("x-file-name-encoding", "uri");
                request.Headers.Add("x-file-size", info.size.ToString(System.Globalization.CultureInfo.InvariantCulture));
                request.Headers.Add("x-file-sha256", info.sha256);
                request.Headers.Add("x-file-controller", binding.controllerId);
                request.Headers.Add("x-file-peer", binding.peerId);
                request.Headers.Add("x-file-instance", AgentProcessState.Instance);
                request.Headers.Add("x-file-direction", direction);
                return request;
            }, deadline.Token);
            if (!response.IsSuccessStatusCode) return false;
            using var receipt = JsonDocument.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
            var v = receipt.RootElement;
            return !deadline.IsCancellationRequested && v.GetProperty("ok").GetBoolean() && v.GetProperty("id").GetString() == info.id &&
                v.GetProperty("size").GetInt64() == info.size && v.GetProperty("sha256").GetString() == info.sha256 &&
                v.GetProperty("state").GetString() == (complete ? "delivered" : "reserved");
        }
        catch { return false; }
    }
}
