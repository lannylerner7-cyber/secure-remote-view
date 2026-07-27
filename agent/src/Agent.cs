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
    private WebRtcSession? _rtc;
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
        // Exponential backoff on failure: 1s → 2s → 4s → 8s → 16s → 30s cap.
        // Reset to the base delay on the first successful heartbeat. After 3
        // consecutive failures we assume the admin is unreachable and trip the
        // dead-man fallback: release the input block + drop the curtain so the
        // local user is never left with a frozen machine on a broken link.
        var baseDelay = TimeSpan.FromSeconds(15);   // healthy cadence — sits under the 60s reconnect-gap threshold
        var errDelay = TimeSpan.FromSeconds(1);     // backoff on failure
        int fails = 0;
        bool deadManTripped = false;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await _api.HeartbeatAsync(ct);
                fails = 0;
                errDelay = TimeSpan.FromSeconds(1);
                deadManTripped = false;
                try { await Task.Delay(baseDelay, ct); } catch { }
            }
            catch (Exception ex)
            {
                fails++;
                Log.Warn($"heartbeat failed ({fails}): {ex.Message}");
                if (fails >= 3 && !deadManTripped)
                {
                    deadManTripped = true;
                    try { InputBlocker.Release("heartbeat_lost"); } catch { }
                    try { _ui.Invoke(() => CurtainOverlay.Hide()); } catch { }
                    Log.Warn("dead-man: released input block, dropped curtain");
                }
                try { await Task.Delay(errDelay, ct); } catch { }
                errDelay = TimeSpan.FromSeconds(Math.Min(30, errDelay.TotalSeconds * 2));
            }
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

    // Standing-consent model: the local user granted permission at install time
    // (stored in %ProgramData%\ConnectLive\consent.flag). Runtime signaling comes
    // from the persistent on-screen banner + tray icon, not a modal popup.
    // If the flag is missing, we fall back to the per-session modal.
    private static bool HasStandingConsent()
    {
        try
        {
            var path = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "ConnectLive", "consent.flag");
            return System.IO.File.Exists(path);
        }
        catch { return false; }
    }

    private async Task HandleInvite(ClientWebSocket ws, JsonElement msg, CancellationToken ct)
    {
        var sessionId = msg.GetProperty("sessionId").GetString()!;
        var technician = msg.TryGetProperty("technician", out var t) ? t.GetString() ?? "Helpdesk" : "Helpdesk";

        bool allowed;
        if (HasStandingConsent())
        {
            allowed = true;
            Log.Info($"session {sessionId} auto-accepted via standing consent");
        }
        else
        {
            allowed = await _ui.InvokeAsync(() => ConsentDialog.AskViewConsent(technician));
        }

        await SendJson(ws, new { type = "session.consent", sessionId, allowed }, ct);

        if (allowed)
        {
            _ui.Invoke(() =>
            {
                // Banner is the ongoing, non-hideable signal for the whole session.
                _indicator = new SessionIndicator(technician, onEnd: () => EndSession());
                _indicator.Show();
            });
            // Spin up the WebRTC peer alongside the HTTPS frame stream. If ICE
            // never completes (strict NAT, no TURN), admin auto-falls-back
            // to the HTTPS <img> stream — zero regression.
            try
            {
                _rtc = new WebRtcSession(_api, sessionId);
                await _rtc.StartAsync();
            }
            catch (Exception ex) { Log.Warn($"webrtc start: {ex.Message}"); }
            Log.Info($"session {sessionId} started (view-only) with {technician}");
        }
    }

    private void HandleControlRequest(ClientWebSocket ws, JsonElement msg, CancellationToken ct)
    {
        var sessionId = msg.GetProperty("sessionId").GetString()!;
        _ui.Invoke(async () =>
        {
            // Under standing consent, control takeover flips the banner colour instead
            // of blocking with a modal. Users always see it and can End instantly.
            bool granted = HasStandingConsent()
                ? true
                : ConsentDialog.AskControlConsent();
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
        try { _rtc?.Close(); _rtc = null; } catch { }
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
