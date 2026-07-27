using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Coordinator: enroll → heartbeat loop → session invite discovery (HTTPS long-poll).
///
/// The realtime WebSocket path was removed: /heartbeat already returns the
/// list of pending session invites for this device, so a single transport
/// handles both presence and signaling. That eliminates a whole class of
/// idle/NAT disconnects and keeps the agent behind any egress-restricted
/// network as long as HTTPS works.
///
/// Every session is gated by user consent (standing flag or per-session
/// dialog), and a non-hideable SessionIndicator banner stays on-screen for
/// the entire session duration — the technician cannot suppress it.
/// </summary>
public sealed class Agent
{
    private readonly ApiClient _api;
    private readonly Action<string> _splashStatus;
    private readonly Dispatcher _ui;
    private SessionIndicator? _indicator;
    private WebRtcSession? _rtc;
    private readonly HashSet<string> _acceptedSessions = new();
    private string? _currentSessionId;
    private CancellationTokenSource? _sessionCts;
    private CancellationToken _outerCt;

    /// <summary>
    /// Pre-seed a session id restored from disk on cold boot so the next
    /// heartbeat's "active" entry is treated as an already-consented session
    /// rather than a fresh invite.
    /// </summary>
    public void SeedRestoredSession(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId)) return;
        _acceptedSessions.Add(sessionId);
        _currentSessionId = sessionId;
    }

    public Agent(ApiClient api, Action<string> splashStatus, Dispatcher ui)
    {
        _api = api;
        _splashStatus = splashStatus;
        _ui = ui;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        _outerCt = ct;
        _splashStatus("Registering with ConnectLive…");
        await _api.EnrollIfNeededAsync(ct);

        _splashStatus("Sending heartbeat…");
        await _api.HeartbeatAsync(ct);

        // If a session was pre-seeded (cold-boot reconnect), start its loops
        // immediately so we don't wait a whole heartbeat cycle for pixels.
        if (_currentSessionId != null)
            StartSessionLoops(_currentSessionId, "control");

        _splashStatus("Waiting for helpdesk…");
        await HeartbeatLoop(ct);
    }

    /// <summary>
    /// Single loop: heartbeat every ~5s (healthy) with exponential back-off
    /// on failure, and dispatch any pending invites from the response.
    /// </summary>
    private async Task HeartbeatLoop(CancellationToken ct)
    {
        var baseDelay = TimeSpan.FromSeconds(5);   // fast enough that invites feel instant, still under the 60s reconnect-gap threshold
        var errDelay = TimeSpan.FromSeconds(1);
        int fails = 0;
        bool deadManTripped = false;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var body = await _api.HeartbeatAsync(ct);
                fails = 0;
                errDelay = TimeSpan.FromSeconds(1);
                deadManTripped = false;

                await DispatchPendingSessions(body, ct);

                try { await Task.Delay(baseDelay, ct); } catch { }
            }
            catch (Exception ex)
            {
                fails++;
                Log.Warn($"heartbeat failed ({fails}): {ex.Message}");
                if (fails >= 3 && !deadManTripped)
                {
                    // Dead-man fallback: release the input block + drop the curtain
                    // so the user is never left with a frozen machine on a broken link.
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

    private async Task DispatchPendingSessions(string body, CancellationToken ct)
    {
        List<(string id, string state, string mode)> pending = new();
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("sessions", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var el in arr.EnumerateArray())
                {
                    var id = el.TryGetProperty("id", out var i) ? i.GetString() : null;
                    var state = el.TryGetProperty("state", out var s) ? s.GetString() : null;
                    var mode = el.TryGetProperty("mode", out var m) ? m.GetString() : "view";
                    if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(state))
                        pending.Add((id!, state!, mode ?? "view"));
                }
            }
        }
        catch (Exception ex) { Log.Warn($"heartbeat parse: {ex.Message}"); return; }

        foreach (var s in pending)
        {
            if (s.state == "invited" && !_acceptedSessions.Contains(s.id))
            {
                await HandleInvite(s.id, s.mode, ct);
            }
            else if (s.state == "active" && !_acceptedSessions.Contains(s.id))
            {
                // Cold-boot / reconnect edge: server already has consent + active
                // state for this session, but this agent process never joined it.
                // Skip the dialog (consent is on record) and start the loops.
                _acceptedSessions.Add(s.id);
                JoinActiveSession(s.id, s.mode);
            }
        }

        // Session ended on the server side: tear down local session state.
        if (_currentSessionId != null && !pending.Exists(p => p.id == _currentSessionId))
            EndSession();
    }

    private void StartSessionLoops(string sessionId, string mode)
    {
        _sessionCts?.Cancel();
        _sessionCts = CancellationTokenSource.CreateLinkedTokenSource(_outerCt);
        var t = _sessionCts.Token;
        try { InputRelay.SessionBanner = _indicator; } catch { }
        _ = ScreenCapture.RunAsync(_api, sessionId, t);
        _ = InputRelay.RunAsync(_api, sessionId, t);
        _ = CursorPump.RunAsync(_api, sessionId, t);
        Log.Info($"session {sessionId} loops started ({mode})");
    }

    private void JoinActiveSession(string sessionId, string mode)
    {
        _currentSessionId = sessionId;
        _ui.Invoke(() =>
        {
            _indicator = new SessionIndicator("Helpdesk", onEnd: EndSession);
            _indicator.Show();
            if (mode == "control") _indicator?.SetControlGranted(true);
        });
        StartSessionLoops(sessionId, mode);
        try
        {
            _rtc = new WebRtcSession(_api, sessionId);
            _ = _rtc.StartAsync();
        }
        catch (Exception ex) { Log.Warn($"webrtc start: {ex.Message}"); }
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

    private async Task HandleInvite(string sessionId, string mode, CancellationToken ct)
    {
        const string technician = "Helpdesk";

        bool allowed = HasStandingConsent()
            ? true
            : await _ui.InvokeAsync(() => ConsentDialog.AskViewConsent(technician));

        if (!allowed)
        {
            _acceptedSessions.Add(sessionId); // don't re-prompt
            try { await _api.SubmitConsentAsync(sessionId, false, ct); } catch { }
            return;
        }

        try { await _api.SubmitConsentAsync(sessionId, true, ct); }
        catch (Exception ex) { Log.Warn($"consent submit: {ex.Message}"); return; }

        _acceptedSessions.Add(sessionId);
        _currentSessionId = sessionId;

        _ui.Invoke(() =>
        {
            _indicator = new SessionIndicator(technician, onEnd: EndSession);
            _indicator.Show();
            if (mode == "control") _indicator?.SetControlGranted(true);
        });

        // Spin up WebRTC alongside the HTTPS frame stream. If ICE fails,
        // admin auto-falls-back to the HTTPS <img> stream — zero regression.
        try
        {
            _rtc = new WebRtcSession(_api, sessionId);
            await _rtc.StartAsync();
        }
        catch (Exception ex) { Log.Warn($"webrtc start: {ex.Message}"); }

        Log.Info($"session {sessionId} started ({mode}) with {technician}");
    }

    private void EndSession()
    {
        _ui.Invoke(() =>
        {
            _indicator?.Close();
            _indicator = null;
        });
        try { _rtc?.Close(); _rtc = null; } catch { }
        _currentSessionId = null;
        Log.Info("session ended");
    }
}

internal static class Log
{
    public static void Info(string m) => Console.WriteLine($"[info] {DateTime.Now:HH:mm:ss} {m}");
    public static void Warn(string m) => Console.WriteLine($"[warn] {DateTime.Now:HH:mm:ss} {m}");
}

// Platform dispatcher — bound to WPF Application.Current.Dispatcher in App.xaml.cs.
public interface Dispatcher
{
    void Invoke(Action a);
    Task<T> InvokeAsync<T>(Func<T> a);
}
