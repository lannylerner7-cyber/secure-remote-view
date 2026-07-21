using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>
/// Curtain-mode input blocker. Wraps user32!BlockInput with a strict
/// dead-man switch:
///
///   - AppDomain.ProcessExit / UnhandledException -> release
///   - Watchdog: no admin ping in 5s -> release
///   - SystemEvents.SessionSwitch (Ctrl+Alt+Del / lock) -> release
///
/// BlockInput requires elevated/interactive privileges. When it fails,
/// we surface that back to the admin rather than silently no-oping.
/// </summary>
public static class InputBlocker
{
    [DllImport("user32.dll")] private static extern bool BlockInput(bool fBlockIt);

    private static readonly object _lock = new();
    private static bool _engaged;
    private static long _lastPingTicks;
    private static Thread? _watchdog;
    private static Action<string>? _onAutoRelease;

    public static bool IsEngaged { get { lock (_lock) return _engaged; } }

    static InputBlocker()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => ForceRelease("process_exit");
        AppDomain.CurrentDomain.UnhandledException += (_, _) => ForceRelease("unhandled_exception");
        SystemEvents.SessionSwitch += (_, e) =>
        {
            // ConsoleDisconnect / SessionLock / SessionLogoff => user hit Ctrl+Alt+Del,
            // locked the box, or switched user. Windows already suspended BlockInput;
            // tear down our UI so they don't return to a "dark screen".
            if (e.Reason == SessionSwitchReason.ConsoleDisconnect ||
                e.Reason == SessionSwitchReason.SessionLock ||
                e.Reason == SessionSwitchReason.SessionLogoff ||
                e.Reason == SessionSwitchReason.RemoteDisconnect)
            {
                ForceRelease("session_switch:" + e.Reason);
            }
        };
        SystemEvents.SessionEnding += (_, _) => ForceRelease("session_ending");
    }

    /// <summary>Admin requested curtain on. Also refreshes the watchdog.</summary>
    public static bool Engage(Action<string>? onAutoRelease = null)
    {
        lock (_lock)
        {
            _onAutoRelease = onAutoRelease ?? _onAutoRelease;
            _lastPingTicks = DateTime.UtcNow.Ticks;
            if (_engaged) return true;

            bool ok = BlockInput(true);
            _engaged = ok;
            if (!ok)
            {
                Log.Warn("BlockInput(true) failed — agent is likely not elevated");
                return false;
            }

            if (_watchdog == null || !_watchdog.IsAlive)
            {
                _watchdog = new Thread(WatchdogLoop) { IsBackground = true, Name = "curtain-watchdog" };
                _watchdog.Start();
            }
            Log.Info("curtain engaged");
            return true;
        }
    }

    /// <summary>Called every ~1s by the input-poll loop while curtain is on.</summary>
    public static void Heartbeat()
    {
        lock (_lock) { if (_engaged) _lastPingTicks = DateTime.UtcNow.Ticks; }
    }

    public static void Release(string reason = "admin")
    {
        lock (_lock)
        {
            if (!_engaged) return;
            BlockInput(false);
            _engaged = false;
            Log.Info($"curtain released ({reason})");
        }
        _onAutoRelease?.Invoke(reason);
    }

    private static void ForceRelease(string reason)
    {
        try
        {
            lock (_lock)
            {
                if (_engaged) { BlockInput(false); _engaged = false; }
            }
            _onAutoRelease?.Invoke(reason);
        }
        catch { /* best effort */ }
    }

    private static void WatchdogLoop()
    {
        while (true)
        {
            Thread.Sleep(500);
            bool stale;
            lock (_lock)
            {
                if (!_engaged) return;
                var age = TimeSpan.FromTicks(DateTime.UtcNow.Ticks - _lastPingTicks);
                stale = age > TimeSpan.FromSeconds(5);
            }
            if (stale) { ForceRelease("watchdog_stale"); return; }
        }
    }
}
