using System;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

/// <summary>
/// Coordinator: enroll -> heartbeat loop -> realtime WebSocket for session invites.
/// Every session is gated by a fresh consent prompt shown on the user's desktop.
/// A persistent SessionIndicator window is visible for the full duration of any
/// active session and cannot be hidden by the technician side.
/// </summary>
public sealed class Agent
{
    private readonly ApiClient _api;
    private readonly Action<string> _splashStatus;
    private readonly Dispatcher _ui;
    private SessionIndicator? _indicator;
    private bool _controlGranted;

    public Agent(ApiClient api, Action<string> splashStatus, Dispatcher ui)
    {
        _api = api;
        _splashStatus = splashStatus;
        _ui = ui;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        _splashStatus("Registering with ConnectLive…");
        await _api.EnrollIfNeededAsync(ct);

        _splashStatus("Sending heartbeat…");
        await _api.HeartbeatAsync(ct);

        _splashStatus("Waiting for helpdesk…");
        _ = HeartbeatLoop(ct);
        await RealtimeLoop(ct);
    }

    private async Task HeartbeatLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await _api.HeartbeatAsync(ct); }
            catch (Exception ex) { Log.Warn($"heartbeat failed: {ex.Message}"); }
            try { await Task.Delay(TimeSpan.FromSeconds(30), ct); } catch { }
        }
    }

    private async Task RealtimeLoop(CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(2);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var ws = await _api.ConnectRealtimeAsync(ct);
                backoff = TimeSpan.FromSeconds(2);
                await PumpMessages(ws, ct);
            }
            catch (Exception ex)
            {
                Log.Warn($"realtime disconnected: {ex.Message}");
                await Task.Delay(backoff, ct);
                backoff = TimeSpan.FromSeconds(Math.Min(60, backoff.TotalSeconds * 2));
            }
        }
    }

    private async Task PumpMessages(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        var sb = new StringBuilder();
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            WebSocketReceiveResult r;
            sb.Clear();
            do
            {
                r = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                if (r.MessageType == WebSocketMessageType.Close) return;
                sb.Append(Encoding.UTF8.GetString(buffer, 0, r.Count));
            } while (!r.EndOfMessage);

            var msg = JsonDocument.Parse(sb.ToString()).RootElement;
            var type = msg.GetProperty("type").GetString();
            switch (type)
            {
                case "session.invite":     await HandleInvite(ws, msg, ct); break;
                case "session.grantRequest": HandleControlRequest(ws, msg, ct); break;
                case "session.ended":      EndSession(); break;
                // Signaling messages (SDP/ICE) are forwarded to the capture module
                // (not shown here — plug into your WebRTC.NET / MixedReality-WebRTC binding).
            }
        }
    }

    // ---- Consent handshake --------------------------------------------

    private async Task HandleInvite(ClientWebSocket ws, JsonElement msg, CancellationToken ct)
    {
        var sessionId = msg.GetProperty("sessionId").GetString()!;
        var technician = msg.TryGetProperty("technician", out var t) ? t.GetString() ?? "Helpdesk" : "Helpdesk";

        var allowed = await _ui.InvokeAsync(() =>
            ConsentDialog.AskViewConsent(technician));

        var reply = new
        {
            type = "session.consent",
            sessionId,
            allowed
        };
        await SendJson(ws, reply, ct);

        if (allowed)
        {
            _ui.Invoke(() =>
            {
                _indicator = new SessionIndicator(technician, onEnd: () => EndSession());
                _indicator.Show();
            });
            // TODO: start Windows.Graphics.Capture pipeline + WebRTC peer connection here.
            Log.Info($"session {sessionId} started (view-only) with {technician}");
        }
    }

    private void HandleControlRequest(ClientWebSocket ws, JsonElement msg, CancellationToken ct)
    {
        var sessionId = msg.GetProperty("sessionId").GetString()!;
        _ui.Invoke(async () =>
        {
            var granted = ConsentDialog.AskControlConsent();
            _controlGranted = granted;
            _indicator?.SetControlGranted(granted);
            await SendJson(ws, new { type = "session.grantResponse", sessionId, granted }, ct);
            Log.Info($"session {sessionId} control grant: {granted}");
        });
    }

    private void EndSession()
    {
        _controlGranted = false;
        _ui.Invoke(() =>
        {
            _indicator?.Close();
            _indicator = null;
        });
        // TODO: tear down WebRTC peer connection + capture.
        Log.Info("session ended");
    }

    private static async Task SendJson(ClientWebSocket ws, object payload, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }
}

internal static class Log
{
    public static void Info(string m) => Console.WriteLine($"[info] {DateTime.Now:HH:mm:ss} {m}");
    public static void Warn(string m) => Console.WriteLine($"[warn] {DateTime.Now:HH:mm:ss} {m}");
}

// Placeholder for platform dispatcher — bind to WPF Application.Current.Dispatcher.
public interface Dispatcher
{
    void Invoke(Action a);
    Task<T> InvokeAsync<T>(Func<T> a);
}
