using System;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:WAKE — long-lived SSE client against /api/public/agent/stream.
///
/// The route is fully implemented server-side (1 s poll, keepalive comment
/// every 15 s) but nothing on the agent was opening it, so wake commands
/// waited for the next heartbeat tick (up to 10 s). This listener collapses
/// that to sub-second in the healthy case, without changing the source of
/// truth: the heartbeat still dispatches queued commands, so a dropped
/// stream never blocks delivery.
///
/// Design:
///  - One consumer per process, restarted with exponential back-off (max 30 s).
///  - Uses its OWN HttpClient with no read timeout — the shared client has a
///    20 s send timeout which would kill the long-poll every keepalive gap.
///  - Every `event: wake` frame just pings the wake signal; the heartbeat
///    loop is what actually calls DispatchPowerCommands on the row. This
///    keeps idempotency (attempt_id) and rate-limit logic in one place.
/// </summary>
internal sealed class StreamListener
{
    /// <summary>
    /// True while an SSE connection is established and reading. The heartbeat
    /// loop relaxes its idle cadence when this is set, and snaps back to the
    /// fast cadence the moment the stream drops — the heartbeat remains the
    /// authoritative delivery path either way.
    /// </summary>
    public static volatile bool Healthy;

    private readonly ApiClient _api;
    private readonly Action _wakeNudge;
    private readonly HttpClient _http;

    public StreamListener(ApiClient api, Action wakeNudge)
    {
        _api = api;
        _wakeNudge = wakeNudge;
        _http = new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            // No response drain deadline — SSE frames arrive whenever they arrive.
        })
        {
            BaseAddress = new Uri(_api.ApiBaseUrl),
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(1);
        while (!ct.IsCancellationRequested)
        {
            // Wait until enrollment has provisioned a token — the route is
            // device-gated and would 401 without it.
            if (string.IsNullOrEmpty(_api.DeviceToken) || string.IsNullOrEmpty(_api.DeviceId))
            {
                try { await Task.Delay(TimeSpan.FromSeconds(2), ct); } catch { }
                continue;
            }

            try
            {
                await ConsumeAsync(ct);
                // Clean EOF from server-side close: reconnect quickly.
                backoff = TimeSpan.FromSeconds(1);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { Healthy = false; break; }
            catch (Exception ex)
            {
                Log.Warn($"sse: {ex.Message} — reconnecting in {backoff.TotalSeconds:0}s");
                try { await Task.Delay(backoff, ct); } catch { }
                backoff = TimeSpan.FromSeconds(Math.Min(30, backoff.TotalSeconds * 2));
            }
            finally
            {
                // Whatever ended the read, the heartbeat must snap back to its
                // fast cadence until a new stream is proven up.
                Healthy = false;
            }
        }
    }

    private async Task ConsumeAsync(CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/public/agent/stream");
        req.Headers.Add("X-Device-Id", _api.DeviceId!);
        req.Headers.Add("X-Device-Token", _api.DeviceToken!);
        req.Headers.Accept.ParseAdd("text/event-stream");

        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if ((int)resp.StatusCode == 401)
        {
            // Token rotated or revoked — force a re-enroll on the heartbeat side.
            Log.Warn("sse: 401 from stream — dropping and waiting for re-enroll");
            try { await Task.Delay(TimeSpan.FromSeconds(10), ct); } catch { }
            return;
        }
        resp.EnsureSuccessStatusCode();

        Log.Info("sse: connected to /api/public/agent/stream");
        Healthy = true;
        using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);

        string? currentEvent = null;
        string? line;
        while (!ct.IsCancellationRequested && (line = await reader.ReadLineAsync(ct)) != null)
        {
            if (line.Length == 0)
            {
                // Frame terminator — reset accumulator.
                currentEvent = null;
                continue;
            }
            if (line.StartsWith(":", StringComparison.Ordinal)) continue; // keepalive comment
            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                currentEvent = line.Substring(6).Trim();
                continue;
            }
            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (currentEvent == "wake")
                {
                    try { _wakeNudge(); } catch (Exception ex) { Log.Warn($"sse wake nudge: {ex.Message}"); }
                }
                // Any other event ("ready", "error") is diagnostic only.
            }
        }
    }
}
