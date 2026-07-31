using System;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Long-lived Server-Sent Events consumer for GET /api/public/agent/stream.
///
/// The heartbeat loop remains the source of truth for invites and power
/// commands; SSE is purely a latency accelerator so an admin pressing
/// "Connect" surfaces the session UI in well under a second instead of
/// waiting for the next heartbeat tick.
///
/// Owned by App for the whole process lifetime — it is never tied to a window.
/// </summary>
public sealed class StreamListener
{
    private readonly ApiClient _api;
    private readonly Action _onWake;

    /// <summary>True while the SSE stream is connected. Read by Agent to relax heartbeat cadence.</summary>
    public bool Healthy { get; private set; }

    public StreamListener(ApiClient api, Action onWake)
    {
        _api = api;
        _onWake = onWake;
    }

    public void Start(CancellationToken ct) => _ = Task.Run(() => RunAsync(ct), CancellationToken.None);


    private async Task RunAsync(CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(2);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await ConnectOnceAsync(ct);
                backoff = TimeSpan.FromSeconds(2); // clean disconnect → reconnect fast
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                Log.Warn($"sse: {ex.Message}");
                backoff = TimeSpan.FromSeconds(Math.Min(30, backoff.TotalSeconds * 2));
            }
            finally { Healthy = false; }

            try { await Task.Delay(backoff, ct); } catch { return; }
        }
    }


    private async Task ConnectOnceAsync(CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_api.DeviceId) || string.IsNullOrEmpty(_api.DeviceToken))
            throw new InvalidOperationException("not enrolled yet");

        using var http = new HttpClient
        {
            BaseAddress = new Uri(_api.ApiBaseUrl),
            Timeout = Timeout.InfiniteTimeSpan,
        };
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/public/agent/stream");
        req.Headers.Add("X-Device-Id", _api.DeviceId!);
        req.Headers.Add("X-Device-Token", _api.DeviceToken!);
        req.Headers.Add("Accept", "text/event-stream");

        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!resp.IsSuccessStatusCode)
            throw new HttpRequestException($"stream HTTP {(int)resp.StatusCode}");

        Log.Info("sse: stream connected");

        using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);

        string? currentEvent = null;
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) break;                 // server closed → reconnect
            if (line.Length == 0) { currentEvent = null; continue; }
            if (line.StartsWith(':')) continue;      // keepalive comment

            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                currentEvent = line.Substring(6).Trim();
                continue;
            }
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;

            var data = line.Substring(5).Trim();
            if (currentEvent != "wake") continue;

            string? cmdId = null;
            try
            {
                using var doc = JsonDocument.Parse(data);
                if (doc.RootElement.TryGetProperty("id", out var idEl)) cmdId = idEl.GetString();
            }
            catch { /* malformed frame — still treat as a wake nudge */ }

            Log.Info($"sse: wake received (cmd {cmdId ?? "?"})");
            try { _onWake(); } catch (Exception ex) { Log.Warn($"sse wake handler: {ex.Message}"); }

            if (!string.IsNullOrEmpty(cmdId))
            {
                try { await _api.AckPowerCommandAsync(cmdId!, "delivered", null, ct); }
                catch (Exception ex) { Log.Warn($"sse wake ack: {ex.Message}"); }
            }
        }
    }
}
