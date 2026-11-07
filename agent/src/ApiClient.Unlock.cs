using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

public sealed partial class ApiClient
{
    /// <summary>Never replays an unlock/credential-use request after uncertainty.</summary>
    internal async Task<JsonDocument> UnlockRequestAsync(object body, CancellationToken ct)
    {
        var identity = DeviceId; var token = DeviceToken;
        if (string.IsNullOrEmpty(identity) || string.IsNullOrEmpty(token)) throw new InvalidOperationException("unlock_not_paired");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/unlock");
        request.Headers.Add("X-Device-Id", identity);
        request.Headers.Add("X-Device-Token", token);
        request.Content = JsonContent.Create(body);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode || DeviceId != identity || DeviceToken != token)
            throw new InvalidOperationException("unlock_authorization_unavailable");
        if (response.Content.Headers.ContentLength is > 8192) throw new InvalidOperationException("unlock_response_invalid");
        using var stream = await response.Content.ReadAsStreamAsync(ct);
        var bytes = new byte[8193]; int total = 0;
        while (total < bytes.Length)
        {
            int read = await stream.ReadAsync(bytes.AsMemory(total), ct);
            if (read == 0) break;
            total += read;
        }
        if (total > 8192) throw new InvalidOperationException("unlock_response_invalid");
        return JsonDocument.Parse(bytes.AsMemory(0, total));
    }
}
