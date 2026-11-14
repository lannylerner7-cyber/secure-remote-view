using System;
using System.Threading;
using System.Windows;

namespace ConnectLive.Agent;

/// <summary>Transactional local presentation/input pause, owned by one live peer.</summary>
internal static class CurtainController
{
    private static readonly object Gate = new();
    private static readonly CurtainLease Lease = new();
    private static Action<bool, string>? _changed;
    private static long _activation;
    private static readonly Timer Watchdog = new(_ => Tick(), null, 250, 250);
    internal static bool Supported => OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041);

    static CurtainController()
    {
        Microsoft.Win32.SystemEvents.DisplaySettingsChanging += (_, _) =>
        {
            PeerInputPermission? owner;
            lock (Gate) owner = Lease.Owner as PeerInputPermission;
            if (owner != null) Release(owner, "display_changed");
        };
    }

    internal static bool ActiveFor(PeerInputPermission owner)
    {
        lock (Gate) return Lease.Owns(owner, Environment.TickCount64) &&
            InputBlocker.IsEngaged && CurtainOverlay.IsShown;
    }

    internal static void CaptureUnavailable()
    {
        PeerInputPermission? owner;
        lock (Gate) owner = Lease.Owner as PeerInputPermission;
        if (owner != null) Release(owner, "capture_exclusion_unavailable");
    }

    internal static void Enable(PeerInputPermission owner, Action<bool> applied,
        Action<bool, string>? changed = null)
        => EnableDetailed(owner, result => applied(result.Applied), changed);

    internal static void EnableDetailed(PeerInputPermission owner, Action<CurtainApplyResult> applied,
        Action<bool, string>? changed = null)
    {
        if (!Supported) { applied(CurtainApplyResult.Failed("unsupported_windows")); return; }
        if (InputBlocker.LocalStopPending) { applied(CurtainApplyResult.Failed("local_stop")); return; }
        if (!owner.Allows("control")) { applied(CurtainApplyResult.Failed("authorization_changed")); return; }
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher == null || dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished)
        { applied(CurtainApplyResult.Failed("ui_unavailable")); return; }
        long activation;
        lock (Gate)
        {
            // Bound UI work: no repeated HWND construction while another
            // activation is waiting for the dispatcher.
            if (Lease.Owner != null) { applied(CurtainApplyResult.Failed("activation_busy")); return; }
            if (!Lease.Begin(owner, Environment.TickCount64)) { applied(CurtainApplyResult.Failed("lease_expired")); return; }
            activation = ++_activation;
            _changed = changed;
        }
        bool Current()
        {
            lock (Gate) return activation == _activation && Lease.Owns(owner, Environment.TickCount64);
        }
        void Reject(CurtainApplyResult result)
        {
            // Do not let a previous render completion release a newer lease.
            lock (Gate)
                if (activation == _activation && ReferenceEquals(Lease.Owner, owner))
                    Release(owner, result.Reason ?? "display_unavailable");
            applied(result);
        }
        try
        {
            dispatcher.BeginInvoke(new Action(async () =>
            {
                try
                {
                    // Never hold Gate while waiting for WPF or installing native hooks.
                    if (!Current() || !owner.Allows("control"))
                    { Reject(CurtainApplyResult.Failed("authorization_changed")); return; }
                    var display = await CurtainOverlay.ShowRenderedAsync();
                    if (!display.Applied) { Reject(display); return; }
                    // Visible, capture-excluded windows come BEFORE local input pause.
                    if (!Current() || InputBlocker.LocalStopPending || !owner.Allows("control"))
                    { Reject(CurtainApplyResult.Failed("authorization_changed")); return; }
                    if (!InputBlocker.Engage(OnBlockerRelease))
                    { Reject(CurtainApplyResult.Failed("input_pause_unavailable")); return; }
                    if (!Current() || !owner.Allows("control"))
                    { Reject(CurtainApplyResult.Failed("authorization_changed")); return; }
                    InputBlocker.Heartbeat();
                    Log.Info("privacy curtain applied: local notice rendered and input pause active");
                    applied(CurtainApplyResult.Success);
                }
                catch (Exception ex)
                {
                    Log.Warn($"curtain activation failed: type={ex.GetType().Name}");
                    Reject(CurtainApplyResult.Failed("display_render_failed"));
                }
            }));
        }
        catch { Reject(CurtainApplyResult.Failed("ui_unavailable")); }
    }

    internal static bool Renew(PeerInputPermission owner)
    {
        if (InputBlocker.LocalStopPending || !owner.Allows("control")) { Release(owner, "authorization_changed"); return false; }
        lock (Gate)
        {
            if (!InputBlocker.IsEngaged || !CurtainOverlay.IsShown ||
                !Lease.Renew(owner, Environment.TickCount64)) return false;
            InputBlocker.Heartbeat();
            return true;
        }
    }

    internal static void Release(PeerInputPermission owner, string reason, Action<bool>? applied = null)
    {
        Action<bool, string>? changed = null;
        long generation;
        lock (Gate)
        {
            if (Lease.Owner != null && !ReferenceEquals(Lease.Owner, owner)) { applied?.Invoke(false); return; }
            _activation++;
            Lease.End(owner);
            changed = _changed;
            _changed = null;
            InputBlocker.Release(reason);
            generation = _activation;
        }
        HideWhenInactive(generation, hidden =>
        {
            if (hidden) changed?.Invoke(false, reason);
            applied?.Invoke(hidden);
        });
    }

    private static void OnBlockerRelease(string reason)
    {
        Action<bool, string>? changed;
        long generation;
        lock (Gate)
        {
            _activation++;
            if (Lease.Owner is { } owner) Lease.End(owner);
            changed = _changed;
            _changed = null;
            generation = _activation;
        }
        // A curtain timeout must not leave remote-held keys/buttons pressed
        // after ordinary local input has been restored.
        try { InputRelay.ReleaseHeldInputs(); } catch { }
        HideWhenInactive(generation, hidden => { if (hidden) changed?.Invoke(false, reason); });
    }

    private static void HideWhenInactive(long generation, Action<bool>? after = null)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher == null || dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished)
        {
            bool hidden;
            lock (Gate) hidden = generation == _activation && Lease.Owner == null && !CurtainOverlay.IsShown;
            after?.Invoke(hidden);
            return;
        }
        try
        {
            dispatcher.BeginInvoke(new Action(() =>
            {
                bool hidden;
                lock (Gate)
                {
                    hidden = generation == _activation && Lease.Owner == null;
                    if (hidden) CurtainOverlay.Hide();
                }
                // A queued release from an older activation must neither hide
                // a new curtain nor publish a false inactive state for it.
                after?.Invoke(hidden);
            }));
        }
        catch { after?.Invoke(false); }
    }

    private static void Tick()
    {
        try
        {
            PeerInputPermission? owner;
            lock (Gate) owner = Lease.Owner as PeerInputPermission;
            if (owner == null) return;
            var authorized = owner.Allows("control");
            bool expired;
            lock (Gate) expired = !Lease.Owns(owner, Environment.TickCount64);
            if (!authorized || expired) Release(owner, authorized ? "lease_expired" : "authorization_changed");
        }
        catch { InputBlocker.Release("curtain_watchdog_error"); }
    }
}
