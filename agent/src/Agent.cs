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
/// The application provides persistent status and local withdrawal.
/// </summary>
public sealed class Agent
{
    private readonly ApiClient _api;
    private readonly Action<string> _splashStatus;
    private readonly Dispatcher _ui;
    private readonly Action? _onWake;
    private readonly SemaphoreSlim _wakeSignal = new(0, 1);
    private WebRtcSession? _rtc;
    private PeerInputPermission? _peerInputPermission;
    private readonly HashSet<string> _acceptedSessions = new();
    // Invites whose consent dialog is currently on screen. The heartbeat
    // re-lists an `invited` session every cycle; without this the user would
    // get a new dialog every few seconds while deciding.
    private readonly HashSet<string> _promptingSessions = new();

    private string? _currentSessionId;
    private string? _loopSessionId;
    private string? _loopMode;
    private CancellationTokenSource? _sessionCts;
    private Task? _screenTask;
    private Task? _inputTask;
    private Task? _cursorTask;
    private CancellationToken _outerCt;
    private volatile bool _locallyStopped;
    private volatile bool _authorityMatches;
    private volatile bool _authorizationSuspended;
    private long _authorityEpoch;
    private HashSet<string> _eligibleInvites = new();

    private bool HasAuthority => !_locallyStopped && !_authorizationSuspended &&
        !LocalAccessState.IsDisabled() && _authorityMatches &&
        _api.LocalAuthorization?.DeviceId == _api.DeviceId && _api.DeviceId != null;

    private bool CheckAuthority(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var remote = doc.RootElement.TryGetProperty("authorization", out var a) ? AuthorizationGrant.Parse(a) : null;
            _authorityMatches = _api.LocalAuthorization?.Matches(_api.ApiBaseUrl, _api.DeviceId, remote) == true;
        }
        catch { _authorityMatches = false; }
        if (!_authorityMatches) EndSession();
        return HasAuthority;
    }

    public void StopLocally()
    {
        _locallyStopped = true;
        EndSession();
    }

    internal void SuspendForAuthorization()
    {
        _authorizationSuspended = true;
        _authorityMatches = false;
        EndSession();
    }

    internal void ResumeAfterAuthorization()
    {
        _authorityMatches = false; // A new heartbeat must validate the saved replacement.
        _authorizationSuspended = false;
        RequestWake();
    }

    /// <summary>Raised with a human-readable session state for tray/status UI.</summary>
    public event Action<string>? SessionStateChanged;

    private void ReportState(string s)
    {
        try { SessionStateChanged?.Invoke(s); } catch { }
    }

    /// <summary>
    /// Retained for source compatibility only. A disk session ID is never
    /// interpreted as attended consent or as a recorded endpoint grant.
    /// </summary>
    public void SeedRestoredSession(string sessionId)
    {
        // Disk session bindings are not consent evidence.
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
        _ui = ui;
        _api.LiveAuthorityRejected += () =>
        {
            _authorityMatches = false;
            // The HTTP rejection may arrive on a capture/input worker.
            // Close its permission immediately, then serialize coordinator
            // collections and peer teardown on the application dispatcher.
            _peerInputPermission?.Revoke();
            try { _sessionCts?.Cancel(); } catch { }
            _ui.Invoke(EndSession);
        };
        _splashStatus = splashStatus;
        _onWake = onWake;
        PowerRelay.OnWakeAgent = RequestWake;
        PowerRelay.OnRestartStream = RestartStreamAsync;
        PowerRelay.OnRestartAgent = SoftRestartAsync;
    }

    // Standalone Agent: no helper service. Wake arrives over the in-process SSE
    // channel (see _stream / StreamListener below), and the heartbeat cadence is
    // decided by session activity plus StreamListener.Healthy (fastDelay /
    // slowDelay below).

    /// <summary>Rebuild the WebRTC peer + capture pipeline for the current session without exiting.</summary>
    public Task RestartStreamAsync()
    {
        if (!HasAuthority || _outerCt.IsCancellationRequested) return Task.CompletedTask;
        var sid = _currentSessionId;
        if (string.IsNullOrEmpty(sid))
        {
            Log.Info("restart_stream: no active session; nothing to do");
            return Task.CompletedTask;
        }
        Log.Info($"restart_stream: rebuilding pipeline for session {sid}");
        _peerInputPermission?.Revoke();
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
            _rtc = new WebRtcSession(_api, sid!, _peerInputPermission);
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

    /// <summary>
    /// G5 — presence resilience: Wi-Fi flip, VPN up/down or dock change used to
    /// cost up to a full heartbeat cycle before the agent noticed. Snap a beat
    /// the moment the OS reports a new address so presence recovers in ~0s.
    /// </summary>
    private void SubscribeNetworkChange(CancellationToken ct)
    {
        System.Net.NetworkInformation.NetworkAddressChangedEventHandler? h = null;
        h = (_, _) =>
        {
            Log.Info("network address changed — snapping heartbeat");
            // Signal only: don't surface any UI, this is a background recovery.
            try { if (_wakeSignal.CurrentCount == 0) _wakeSignal.Release(); } catch { }
        };

        try
        {
            System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged += h;
            ct.Register(() =>
            {
                try { System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged -= h; } catch { }
            });
        }
        catch (Exception ex) { Log.Warn($"network watch: {ex.Message}"); }
    }


    public async Task RunAsync(CancellationToken ct)
    {
        if (_locallyStopped || ct.IsCancellationRequested) return;
        _outerCt = ct;
        SubscribeNetworkChange(ct);

        // Log the hardware H.264 encoder capability once per process. The
        // probe is cheap and idempotent; running it at startup means every
        // field log carries the machine's encode ceiling whether or not a
        // session ever opens, which is what tells us how much of the fleet
        // would benefit from the wire-codec flip landing after this turn.
        try { HwEncoderProbe.LogCapability(); } catch { }
        // S17 step 3 kill switch, logged next to the probe so a field machine's
        // codec behaviour is readable from the startup log alone. Inert today —
        // WebRtcSession still pins VP8 unconditionally.
        try { CodecPolicy.LogPolicy(); } catch { }




        // Boot-proof enrollment: retry every 5s forever. Windows Startup fires
        // before Wi-Fi finishes negotiating, so a single failure here used to
        // leave the Agent running but permanently unenrolled.
        _splashStatus("Registering with ConnectLive…");
        while (!ct.IsCancellationRequested)
        {
            try { await _api.EnrollIfNeededAsync(ct); break; }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // The user dismissed the Meeting-ID prompt. Do not re-open it
                // in a loop — stay resident and dormant so the next foreground
                // launch (or a restart) can activate the machine.
                Log.Warn("enroll: Meeting ID prompt cancelled — agent dormant until activated");
                _splashStatus("Activation required — enter your Meeting ID");
                return;
            }
            catch (Exception ex)
            {
                Log.Warn($"enroll retry: {ex.Message}");
                _splashStatus("Waiting for network…");
                try { await Task.Delay(TimeSpan.FromSeconds(5), ct); } catch { }
            }
        }

        if (_locallyStopped || ct.IsCancellationRequested) return;
        _splashStatus("Sending heartbeat…");
        try { CheckAuthority(await _api.HeartbeatAsync(ct)); } catch (Exception ex) { Log.Warn($"first heartbeat: {ex.Message}"); EndSession(); }

        // If a session was pre-seeded (cold-boot reconnect), start its loops
        // immediately so we don't wait a whole heartbeat cycle for pixels.
        if (!_locallyStopped && !ct.IsCancellationRequested && _currentSessionId != null)
            JoinActiveSession(_currentSessionId, "view");

        // SCOPE:WAKE — the SSE listener runs alongside the heartbeat. It
        // nudges _wakeSignal on incoming wake events so the heartbeat loop
        // cuts its sleep short and pulls the actual power_command row (source
        // of truth). A stream failure just relaxes to heartbeat-only.
        var stream = new StreamListener(_api, () =>
        {
            try { if (_wakeSignal.CurrentCount == 0) _wakeSignal.Release(); } catch { }
        });
        _ = Task.Run(() => stream.RunAsync(ct), ct);

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
        // With SSE healthy the stream carries wake latency, so heartbeat only
        // needs to be a health signal and command safety net — 60 s. Without
        // SSE the heartbeat IS the wake path, so 10 s is the ceiling.
        var slowDelayFast = TimeSpan.FromSeconds(10);
        var slowDelaySse  = TimeSpan.FromSeconds(60);
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

                if (CheckAuthority(body))
                    await DispatchPendingSessions(body, ct);
                // Presence/wake is not authority for arbitrary remote power actions.

                // S14 — self-update. Only when idle (no live session) and at
                // most hourly; returns true once the replacement process has
                // been launched, at which point this one hands over and exits.
                if (string.IsNullOrEmpty(_currentSessionId) && SelfUpdate.DueForCheck)
                {
                    if (await SelfUpdate.TryUpdateAsync(_api, ct))
                    {
                        Log.Info("self-update: handing over to the new build");
                        Environment.Exit(0);
                        return;
                    }
                }

                // Interruptible sleep: a wake nudge (wake_agent power command)
                // cuts it short. Cadence is fast while a session is active.
                var idleDelay = StreamListener.Healthy ? slowDelaySse : slowDelayFast;
                var delay = string.IsNullOrEmpty(_currentSessionId) ? idleDelay : fastDelay;
                try { await _wakeSignal.WaitAsync(delay, ct); } catch { }

            }
            catch (Exception ex)
            {
                fails++;
                _authorityMatches = false;
                EndSession();
                Log.Warn($"heartbeat failed ({fails}): {ex.Message}");
                if (fails >= 3 && !deadManTripped)
                {
                    // Loss of authority/presence must stop all live-session channels,
                    // not only release local input blocking. Presence retries remain.
                    deadManTripped = true;
                    EndSession();
                    Log.Warn("dead-man: live session stopped after heartbeat loss");
                }
                try { await Task.Delay(errDelay, ct); } catch { }
                errDelay = TimeSpan.FromSeconds(Math.Min(30, errDelay.TotalSeconds * 2));
            }
        }
    }

    private async Task DispatchPowerCommands(string body, CancellationToken ct)
    {
        if (_locallyStopped || ct.IsCancellationRequested) return;
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
        if (!HasAuthority || ct.IsCancellationRequested) return;
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
                    var mode = el.TryGetProperty("mode", out var m) ? m.GetString() : null;
                    if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(state))
                        pending.Add((id!, state!, mode ?? ""));
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"heartbeat parse: {ex.Message}");
            EndSession();
            return;
        }

        _eligibleInvites = new HashSet<string>(pending.FindAll(p => p.state == "invited").ConvertAll(p => p.id + "|" + p.mode));
        foreach (var s in pending)
        {
            if (s.mode is not ("view" or "control") ||
                !_api.LocalAuthorization!.Authorization.Capabilities.Allows(s.mode))
            {
                if (_currentSessionId == s.id) EndSession();
                continue;
            }
            if (s.state == "invited" && !_acceptedSessions.Contains(s.id))
            {
                // Fire-and-forget: the consent dialog can sit on screen for up
                // to 90s and the heartbeat loop must keep reporting presence
                // (and must keep noticing an admin-cancelled invite) while the
                // user decides. HandleInvite is self-guarded against reentry.
                _ = HandleInvite(s.id, s.mode, ct);
            }
            else if (s.state == "paused")
            {
                // G4: pause means STOP THE PIXELS, keep the session. Nothing
                // leaves the machine while the user works on their own window.
                if (!_acceptedSessions.Contains(s.id)) continue;
                _currentSessionId = s.id;
                PauseSessionLoops(s.id);
            }
            // `consented` never occurs: the server's consent route transitions
            // invited -> active | declined directly. Branching on it was dead
            // code that hid the real state machine.
            else if (s.state == "active")

            {
                if (!_acceptedSessions.Contains(s.id) || _currentSessionId != s.id)
                {
                    // A current matching local unattended grant permits a
                    // server-validated active row without a recurring prompt.
                    // Attended cold restarts require a fresh invite instead.
                    if (_api.LocalAuthorization!.Authorization.Mode == "unattended")
                    {
                        _acceptedSessions.Add(s.id);
                        JoinActiveSession(s.id, s.mode);
                    }
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
        if (_currentSessionId != null && !pending.Exists(p =>
            p.id == _currentSessionId && (p.state == "active" || p.state == "paused" || p.state == "invited")))
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
        if (_loopMode != mode)
        {
            JoinActiveSession(sessionId, mode);
            return;
        }
        _peerInputPermission?.SetMode(mode);
        if (mode != "control")
        {
            try { InputBlocker.Release("control_permission_removed"); } catch { }
            try { _ui.Invoke(() => CurtainOverlay.Hide()); } catch { }
        }
        if (SessionLoopsHealthy(sessionId)) return;
        Log.Warn($"session {sessionId} loop health check failed; restarting loops");
        JoinActiveSession(sessionId, mode);
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
        if (!HasAuthority || _outerCt.IsCancellationRequested ||
            !_api.LocalAuthorization!.Authorization.Capabilities.Allows(mode)) return;
        _peerInputPermission?.Revoke();
        try { InputRelay.ReleaseHeldInputs(); } catch { }
        try { _rtc?.Close(); } catch { }
        _rtc = null;
        _peerInputPermission = new PeerInputPermission(mode,
            _api.LocalAuthorization!.Authorization.Capabilities, () => HasAuthority);
        _api.LivePermission = _peerInputPermission;
        _api.LiveSessionId = sessionId;
        _sessionCts?.Cancel();
        _sessionCts = CancellationTokenSource.CreateLinkedTokenSource(_outerCt);
        var t = _sessionCts.Token;
        _loopSessionId = sessionId;
        _loopMode = mode;
        _screenTask = RunSessionLoop("screen", sessionId, ct => ScreenCapture.RunAsync(_api, sessionId, ct), t);
        _inputTask = RunSessionLoop("input", sessionId, ct => InputRelay.RunAsync(_api, sessionId, ct), t);
        _cursorTask = RunSessionLoop("cursor", sessionId, ct => CursorPump.RunAsync(_api, sessionId, ct), t);
        Log.Info($"session {sessionId} loops started ({mode})");
        ReportState($"Session active ({mode})");
    }

    private void JoinActiveSession(string sessionId, string mode)
    {
        if (!HasAuthority || _outerCt.IsCancellationRequested) return;
        _currentSessionId = sessionId;
        try { _onWake?.Invoke(); } catch { }
        StartSessionLoops(sessionId, mode);
        try
        {
            _rtc = new WebRtcSession(_api, sessionId, _peerInputPermission);
            _ = _rtc.StartAsync();
        }
        catch (Exception ex) { Log.Warn($"webrtc start: {ex.Message}"); }
    }

    // ---- Session activation -------------------------------------------

    private async Task HandleInvite(string sessionId, string mode, CancellationToken ct)
    {
        if (!HasAuthority || ct.IsCancellationRequested ||
            !_api.LocalAuthorization!.Authorization.Capabilities.Allows(mode)) return;
        var epoch = Interlocked.Read(ref _authorityEpoch);
        const string technician = "Helpdesk";

        // Never process the same invite twice: the heartbeat re-lists the
        // invite every few seconds until the server moves it out of `invited`.
        if (!_promptingSessions.Add(sessionId)) return;

        try
        {
            var accepted = _api.LocalAuthorization!.Authorization.Mode == "unattended" ||
                await _ui.InvokeAsync(() => System.Windows.MessageBox.Show(
                    $"Helpdesk requests a {mode} session. Your recorded capability limits still apply. Allow this session?",
                    "ConnectLive — session request", System.Windows.MessageBoxButton.YesNo,
                    System.Windows.MessageBoxImage.Question, System.Windows.MessageBoxResult.No) == System.Windows.MessageBoxResult.Yes);
            if (!HasAuthority || ct.IsCancellationRequested || epoch != Interlocked.Read(ref _authorityEpoch) ||
                ( _api.LocalAuthorization!.Authorization.Mode == "attended" && !_eligibleInvites.Contains(sessionId + "|" + mode))) return;

            try { await _api.SubmitConsentAsync(sessionId, accepted, ct); }
            catch (Exception ex) { Log.Warn($"session accept submit: {ex.Message}"); return; }
            if (!accepted) return;
        }
        finally { _promptingSessions.Remove(sessionId); }

        if (!HasAuthority || ct.IsCancellationRequested || epoch != Interlocked.Read(ref _authorityEpoch)) return;

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
            _rtc = new WebRtcSession(_api, sessionId, _peerInputPermission);
            await _rtc.StartAsync();
        }
        catch (Exception ex) { Log.Warn($"webrtc start: {ex.Message}"); }

        Log.Info($"session {sessionId} started ({mode}) with {technician}");
    }

    /// <summary>
    /// Pause stops live channels, including peer clipboard/files/input.
    /// Keep the server session identity and authorized presence, not the peer.
    /// </summary>
    private void PauseSessionLoops(string sessionId)
    {
        Interlocked.Increment(ref _authorityEpoch);
        _peerInputPermission?.Revoke();
        try { InputRelay.ReleaseHeldInputs(); } catch { }
        try { _sessionCts?.Cancel(); } catch { }
        _sessionCts = null;
        _loopSessionId = null;
        _screenTask = null;
        _inputTask = null;
        _cursorTask = null;
        try { _rtc?.Close(); } catch (Exception ex) { Log.Warn($"pause peer close: {ex.Message}"); }
        _rtc = null;
        // No cached acceptance may restore a paused session without the next
        // authoritative active-state observation.
        try { InputBlocker.Release("session_paused"); } catch { }
        try { _ui.Invoke(() => CurtainOverlay.Hide()); } catch { }
        ReportState("Session paused");
        Log.Info($"session {sessionId} paused — live channels stopped");
    }

    private void EndSession()
    {
        Interlocked.Increment(ref _authorityEpoch);
        _peerInputPermission?.Revoke();
        try { InputRelay.ReleaseHeldInputs(); } catch { }
        try { _sessionCts?.Cancel(); } catch { }
        _sessionCts = null;
        _loopSessionId = null;
        _screenTask = null;
        _inputTask = null;
        _cursorTask = null;
        try { _rtc?.Close(); } catch (Exception ex) { Log.Warn($"end peer close: {ex.Message}"); }
        _rtc = null;
        _acceptedSessions.Clear();
        _currentSessionId = null;
        try { InputBlocker.Release("session_ended"); } catch { }
        try { _ui.Invoke(() => CurtainOverlay.Hide()); } catch { }
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
