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
    {
        if (!Supported || InputBlocker.LocalStopPending || !owner.Allows("control") || Application.Current == null) { applied(false); return; }
        lock (Gate)
        {
            // Bound UI work: no repeated HWND construction while another
            // activation is waiting for the dispatcher.
            if (Lease.Owner != null) { applied(false); return; }
            if (!Lease.Begin(owner, Environment.TickCount64)) { applied(false); return; }
            _changed = changed;
        }
        Application.Current.Dispatcher.BeginInvoke(new Action(async () =>
        {
            // Never hold Gate while waiting for WPF or installing native hooks.
            bool valid = owner.Allows("control");
            lock (Gate) valid &= Lease.Owns(owner, Environment.TickCount64);
            if (!valid || !await CurtainOverlay.ShowRenderedAsync()) { Release(owner, "display_unavailable"); applied(false); return; }
            // Visible, capture-excluded windows come BEFORE local input pause.
            valid = !InputBlocker.LocalStopPending && owner.Allows("control");
            lock (Gate) valid &= Lease.Owns(owner, Environment.TickCount64);
            if (!valid || !InputBlocker.Engage(OnBlockerRelease))
            { Release(owner, "input_pause_unavailable"); applied(false); return; }
            valid = owner.Allows("control");
            lock (Gate) valid &= Lease.Owns(owner, Environment.TickCount64);
            if (!valid) { Release(owner, "authorization_changed"); applied(false); return; }
            InputBlocker.Heartbeat();
            Log.Info("privacy curtain applied: local notice rendered and input pause active");
            applied(true);
        }));
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
        lock (Gate)
        {
            if (Lease.Owner != null && !ReferenceEquals(Lease.Owner, owner)) { applied?.Invoke(false); return; }
            Lease.End(owner);
            changed = _changed;
            _changed = null;
            InputBlocker.Release(reason);
        }
        HideWhenInactive(() => { changed?.Invoke(false, reason); applied?.Invoke(true); });
    }

    private static void OnBlockerRelease(string reason)
    {
        Action<bool, string>? changed;
        lock (Gate)
        {
            if (Lease.Owner is { } owner) Lease.End(owner);
            changed = _changed;
            _changed = null;
        }
        // A curtain timeout must not leave remote-held keys/buttons pressed
        // after ordinary local input has been restored.
        try { InputRelay.ReleaseHeldInputs(); } catch { }
        HideWhenInactive(() => changed?.Invoke(false, reason));
    }

    private static void HideWhenInactive(Action? after = null)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher == null) { after?.Invoke(); return; }
        dispatcher.BeginInvoke(new Action(() =>
        {
            lock (Gate) { if (Lease.Owner == null) CurtainOverlay.Hide(); }
            after?.Invoke();
        }));
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
