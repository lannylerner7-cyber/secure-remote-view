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
/// The Agent is headless: no tray, no banner. Curtain / input-block are
/// gated by explicit admin commands with dead-man release safeguards.
/// </summary>
public sealed class Agent
{
    private readonly ApiClient _api;
    private readonly Action<string> _splashStatus;
    private readonly Dispatcher _ui;
    private readonly Action? _onWake;
    private readonly SemaphoreSlim _wakeSignal = new(0, 1);
    private WebRtcSession? _rtc;
    private readonly HashSet<string> _acceptedSessions = new();
    private string? _currentSessionId;
    private string? _loopSessionId;
    private CancellationTokenSource? _sessionCts;
    private Task? _screenTask;
    private Task? _inputTask;
    private Task? _cursorTask;
    private CancellationToken _outerCt;

    /// <summary>Raised with a human-readable session state for tray/status UI.</summary>
    public event Action<string>? SessionStateChanged;

    private void ReportState(string s)
    {
        try { SessionStateChanged?.Invoke(s); } catch { }
    }

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

    /// <summary>
    /// Wake nudge from SSE or a wake_agent power command: surface the UI and
    /// break the heartbeat sleep so a pending invite is picked up immediately.
    /// </summary>
    public void RequestWake()
    {
        try { _onWake?.Invoke(); } catch (Exception ex) { Log.Warn($"wake handler: {ex.Message}"); }
        try { if (_wakeSignal.CurrentCount == 0) _wakeSignal.Release(); } catch { }
    }

    public Agent(ApiClient api, Action<string> splashStatus, Dispatcher ui, Action? onWake = null)
    {
        _api = api;
        _splashStatus = splashStatus;
        _ui = ui;
        _onWake = onWake;
        PowerRelay.OnWakeAgent = RequestWake;
        PowerRelay.OnRestartStream = RestartStreamAsync;
        PowerRelay.OnRestartAgent = SoftRestartAsync;
    }

    // Standalone Agent: no SSE listener, no helper service. Heartbeat cadence
    // is decided purely by session activity (see fastDelay / slowDelay below).

    /// <summary>Rebuild the WebRTC peer + capture pipeline for the current session without exiting.</summary>
    public Task RestartStreamAsync()
    {
        var sid = _currentSessionId;
        if (string.IsNullOrEmpty(sid))
        {
            Log.Info("restart_stream: no active session; nothing to do");
            return Task.CompletedTask;
        }
        Log.Info($"restart_stream: rebuilding pipeline for session {sid}");
        try { _sessionCts?.Cancel(); } catch { }
        _sessionCts = null;
        _loopSessionId = null;
        _screenTask = _inputTask = _cursorTask = null;
        try { _rtc?.Close(); } catch { }
        _rtc = null;
        // Re-establish loops + WebRTC. Mode falls back to "view" — the next
        // heartbeat will re-apply "control" if the admin still holds it.
        StartSessionLoops(sid!, "view");
        try
        {
            _rtc = new WebRtcSession(_api, sid!);
            _ = _rtc.StartAsync();
        }
        catch (Exception ex) { Log.Warn($"restart_stream webrtc: {ex.Message}"); }
        return Task.CompletedTask;
    }

    /// <summary>In-process soft restart: tears down session + re-enrolls + wakes heartbeat.</summary>
    public async Task SoftRestartAsync()
    {
        Log.Info("restart_agent: soft-restart in progress");
        try { EndSession(); } catch { }
        _acceptedSessions.Clear();
        try { await _api.EnrollIfNeededAsync(_outerCt); } catch (Exception ex) { Log.Warn($"soft-restart enroll: {ex.Message}"); }
        RequestWake(); // force an immediate heartbeat tick
        Log.Info("restart_agent: soft-restart complete");
    }



    public async Task RunAsync(CancellationToken ct)
    {
        _outerCt = ct;

        // Boot-proof enrollment: retry every 5s forever. Windows Startup fires
        // before Wi-Fi finishes negotiating, so a single failure here used to
        // leave the Agent running but permanently unenrolled.
        _splashStatus("Registering with ConnectLive…");
        while (!ct.IsCancellationRequested)
        {
            try { await _api.EnrollIfNeededAsync(ct); break; }
            catch (Exception ex)
            {
                Log.Warn($"enroll retry: {ex.Message}");
                _splashStatus("Waiting for network…");
                try { await Task.Delay(TimeSpan.FromSeconds(5), ct); } catch { }
            }
        }

        _splashStatus("Sending heartbeat…");
        try { await _api.HeartbeatAsync(ct); } catch (Exception ex) { Log.Warn($"first heartbeat: {ex.Message}"); }

        // If a session was pre-seeded (cold-boot reconnect), start its loops
        // immediately so we don't wait a whole heartbeat cycle for pixels.
        if (_currentSessionId != null)
            JoinActiveSession(_currentSessionId, "view");

        _splashStatus("Waiting for helpdesk…");
        await HeartbeatLoop(ct);
    }

    /// <summary>
    /// Single loop: heartbeat every ~5s (SSE unhealthy) or ~60s (SSE healthy),
    /// with exponential back-off on failure. A wake nudge cuts the sleep short
    /// so pending invites are picked up within a beat.
    /// </summary>
    private async Task HeartbeatLoop(CancellationToken ct)
    {
        var fastDelay = TimeSpan.FromSeconds(5);
        // Standalone mode has no helper/SSE process. Keep idle command pickup
        // responsive instead of leaving wake/restart queued for up to a minute.
        var slowDelay = TimeSpan.FromSeconds(10);
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
                await DispatchPowerCommands(body, ct);

                // Interruptible sleep: a wake nudge (wake_agent power command)
                // cuts it short. Cadence is fast while a session is active.
                var delay = string.IsNullOrEmpty(_currentSessionId) ? slowDelay : fastDelay;
                try { await _wakeSignal.WaitAsync(delay, ct); } catch { }

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

    private async Task DispatchPowerCommands(string body, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("power_commands", out var arr)) return;
            if (arr.ValueKind != JsonValueKind.Array) return;
            foreach (var el in arr.EnumerateArray())
            {
                // Fire-and-forget so slow relays don't back the heartbeat loop up.
                var cmd = el.Clone();
                _ = Task.Run(() => PowerRelay.HandleAsync(_api, cmd, ct), ct);
            }
        }
        catch (Exception ex) { Log.Warn($"power dispatch: {ex.Message}"); }
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
            else if (s.state == "paused")
            {
                // G4: pause means STOP THE PIXELS, keep the session. Nothing
                // leaves the machine while the user works on their own window.
                _acceptedSessions.Add(s.id);
                _currentSessionId = s.id;
                PauseSessionLoops(s.id);
            }
            else if (s.state == "active" || s.state == "consented")
            {
                if (!_acceptedSessions.Contains(s.id) || _currentSessionId != s.id)
                {
                    // Cold-boot / reconnect edge: server already has an active
                    // state for this session, but this agent process never joined it.
                    // Start the loops immediately so the admin does not see a stale
                    // live view while waiting for a modal that may be hidden/minimized.
                    _acceptedSessions.Add(s.id);
                    JoinActiveSession(s.id, s.mode);
                }
                else
                {
                    // Also the resume path: a paused session cancelled its loops,
                    // so the health check fails here and they restart cleanly.
                    EnsureSessionLoops(s.id, s.mode);
                }
            }

        }

        // Session ended on the server side: tear down local session state.
        if (_currentSessionId != null && !pending.Exists(p => p.id == _currentSessionId))
            EndSession();
    }

    private bool SessionLoopsHealthy(string sessionId)
    {
        return _loopSessionId == sessionId
            && _sessionCts != null
            && !_sessionCts.IsCancellationRequested
            && _screenTask != null && !_screenTask.IsCompleted
            && _inputTask != null && !_inputTask.IsCompleted
            && _cursorTask != null && !_cursorTask.IsCompleted;
    }

    private void EnsureSessionLoops(string sessionId, string mode)
    {
        if (SessionLoopsHealthy(sessionId)) return;
        Log.Warn($"session {sessionId} loop health check failed; restarting loops");
        StartSessionLoops(sessionId, mode);
    }

    private Task RunSessionLoop(string name, string sessionId, Func<CancellationToken, Task> body, CancellationToken token)
    {
        return Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await body(token);
                    if (!token.IsCancellationRequested)
                        Log.Warn($"{name} loop exited unexpectedly for session {sessionId}; retrying");
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    Log.Warn($"{name} loop crashed for session {sessionId}: {ex.Message}");
                }

                try { await Task.Delay(1000, token); } catch { }
            }
        }, CancellationToken.None);
    }

    private void StartSessionLoops(string sessionId, string mode)
    {
        _sessionCts?.Cancel();
        _sessionCts = CancellationTokenSource.CreateLinkedTokenSource(_outerCt);
        var t = _sessionCts.Token;
        _loopSessionId = sessionId;
        _screenTask = RunSessionLoop("screen", sessionId, ct => ScreenCapture.RunAsync(_api, sessionId, ct), t);
        _inputTask = RunSessionLoop("input", sessionId, ct => InputRelay.RunAsync(_api, sessionId, ct), t);
        _cursorTask = RunSessionLoop("cursor", sessionId, ct => CursorPump.RunAsync(_api, sessionId, ct), t);
        Log.Info($"session {sessionId} loops started ({mode})");
        ReportState($"Session active ({mode})");
    }

    private void JoinActiveSession(string sessionId, string mode)
    {
        _currentSessionId = sessionId;
        try { _onWake?.Invoke(); } catch { }
        StartSessionLoops(sessionId, mode);
        try
        {
            _rtc = new WebRtcSession(_api, sessionId);
            _ = _rtc.StartAsync();
        }
        catch (Exception ex) { Log.Warn($"webrtc start: {ex.Message}"); }
    }

    // ---- Session activation -------------------------------------------

    private async Task HandleInvite(string sessionId, string mode, CancellationToken ct)
    {
        const string technician = "Helpdesk";

        try { await _api.SubmitConsentAsync(sessionId, true, ct); }
        catch (Exception ex) { Log.Warn($"consent submit: {ex.Message}"); return; }

        _acceptedSessions.Add(sessionId);
        _currentSessionId = sessionId;
        try { _onWake?.Invoke(); } catch { }

        // HTTPS is the primary transport: start the frame/input/cursor loops
        // immediately so the admin panel gets pixels within one frame interval.
        StartSessionLoops(sessionId, mode);

        // WebRTC upgrades on top when ICE completes. If it never does (strict
        // NAT, no TURN), the HTTPS loops above already carry the whole session.
        try
        {
            _rtc = new WebRtcSession(_api, sessionId);
            await _rtc.StartAsync();
        }
        catch (Exception ex) { Log.Warn($"webrtc start: {ex.Message}"); }

        Log.Info($"session {sessionId} started ({mode}) with {technician}");
    }

    /// <summary>
    /// G4 — session paused: cancel the capture/input/cursor loops so no pixels
    /// and no injected input flow, but keep the session (and WebRTC) alive so
    /// resume is instant instead of a full renegotiation.
    /// </summary>
    private void PauseSessionLoops(string sessionId)
    {
        if (_loopSessionId == null && _sessionCts == null) return;
        if (_sessionCts == null || _sessionCts.IsCancellationRequested) return;
        try { _sessionCts.Cancel(); } catch { }
        _sessionCts = null;
        _loopSessionId = null;
        _screenTask = null;
        _inputTask = null;
        _cursorTask = null;
        ReportState("Session paused");
        Log.Info($"session {sessionId} paused — capture and input stopped");
    }

    private void EndSession()
    {
        try { _sessionCts?.Cancel(); } catch { }
        _sessionCts = null;
        _loopSessionId = null;
        _screenTask = null;
        _inputTask = null;
        _cursorTask = null;
        try { _rtc?.Close(); _rtc = null; } catch { }
        _currentSessionId = null;
        ReportState("No active session");
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
