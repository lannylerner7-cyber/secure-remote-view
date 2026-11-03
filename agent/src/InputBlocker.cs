using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>
/// Curtain-mode input filter. Replaces the legacy BlockInput API with
/// WH_MOUSE_LL / WH_KEYBOARD_LL low-level hooks so that:
///
///   - Agent-tagged SendInput events pass through. The marker is not an
///     operating-system security boundary or proof of a sender's identity.
///   - Physical user input is swallowed instantly (return 1) while the
///     curtain is engaged.
///   - Co-op mode works for free: when the curtain is off, hooks are
///     uninstalled and both cursors coexist natively.
///
/// Hooks are installed on a dedicated thread running a Win32 GetMessage
/// pump; CPU cost and latency must be measured on Windows.
///
/// Auto-release paths (unchanged from the BlockInput era):
///   - AppDomain.ProcessExit / UnhandledException
///   - Independent watchdog: no admin renewal in 5s
///   - Physical Ctrl+Alt+Shift+Esc and Windows lock/session changes
/// </summary>
public static class InputBlocker
{
    // Magic dwExtraInfo signature ("CLIV" = ConnectLive) stamped on every
    // SendInput call from InputRelay. Lets the hook distinguish OUR admin
    // inputs from third-party synthetic inputs (gaming mice, auto-clickers)
    // that also carry the LLMHF_INJECTED bit.
    public static readonly IntPtr CONNECTLIVE_INPUT_MAGIC = (IntPtr)0x434C4956;

    // Injection flag masks. Windows sets a LOWER_IL bit in addition to the
    // base INJECTED bit for inputs from lower-integrity processes; checking
    // only the base bit would drop some legitimate admin inputs.
    private const uint LLMHF_INJECTED_MASK = 0x00000001 | 0x00000002;
    private const uint LLKHF_INJECTED_MASK = 0x00000010 | 0x00000020;

    private const int WH_MOUSE_LL = 14;
    private const int WH_KEYBOARD_LL = 13;
    private const int HC_ACTION = 0;
    private const uint WM_QUIT = 0x0012;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    private static readonly object _lock = new();
    private static volatile bool _engaged;
    private static long _lastPingTicks;
    private static Action<string>? _onAutoRelease;
    private static readonly LocalEscapeGesture EscapeGesture = new();
    public static event Action? LocalStopRequested;
    private static volatile bool _localStopPending;
    public static bool LocalStopPending => _localStopPending;
    private static readonly Timer Watchdog;

    // Hook thread state.
    private static Thread? _hookThread;
    private static uint _hookThreadId;
    private static IntPtr _mouseHook = IntPtr.Zero;
    private static IntPtr _kbHook = IntPtr.Zero;
    private static readonly ManualResetEventSlim _hooksReady = new(false);
    private static bool _hooksInstalled;
    // Keep delegate refs alive — GC would otherwise collect them mid-callback.
    private static HookProc? _mouseProc;
    private static HookProc? _kbProc;

    public static bool IsEngaged { get { lock (_lock) return _engaged; } }

    static InputBlocker()
    {
        Watchdog = new Timer(_ => {
            try { CheckWatchdog(TimeSpan.FromSeconds(5)); }
            catch { ForceRelease("watchdog_error"); }
        }, null, 250, 250);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => ForceRelease("process_exit");
        AppDomain.CurrentDomain.UnhandledException += (_, _) => ForceRelease("unhandled_exception");
        SystemEvents.SessionSwitch += (_, e) =>
        {
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
            _lastPingTicks = Environment.TickCount64;
            if (_engaged) return true;
            if (LocalStopPending) return false;

            if (!EnsureHookThread())
            {
                Log.Warn("failed to install low-level hooks — curtain unavailable");
                return false;
            }
            EscapeGesture.Reset();
            _engaged = true;
            Log.Info("curtain engaged (hook filter)");
            return true;
        }
    }

    /// <summary>Called every ~1s by the input-poll loop while curtain is on.</summary>
    public static void Heartbeat()
    {
        lock (_lock) { if (_engaged) _lastPingTicks = Environment.TickCount64; }
    }

    public static void Release(string reason = "admin")
    {
        bool didRelease = false;
        lock (_lock)
        {
            if (!_engaged) return;
            _engaged = false;
            didRelease = true;
            Log.Info($"curtain released ({reason})");
        }
        // Physical input is unblocked the moment _engaged flips false —
        // the hook callback checks it every event. Tearing down the hook
        // thread itself happens lazily so re-engaging is instant.
        if (didRelease) _onAutoRelease?.Invoke(reason);
    }

    /// <summary>
    /// Driven independently of input/capture/UI work, using a monotonic clock.
    /// </summary>
    public static bool CheckWatchdog(TimeSpan maxAge)
    {
        bool stale;
        lock (_lock)
        {
            if (!_engaged) return false;
            var age = TimeSpan.FromMilliseconds(Environment.TickCount64 - _lastPingTicks);
            stale = age > maxAge;
        }
        if (!stale) return false;
        Release("watchdog_stale");
        return true;
    }

    /// <summary>
    /// Fully unhooks and stops the hook thread. Called on process shutdown
    /// or when we want a clean slate. Safe to call multiple times.
    /// </summary>
    public static void Shutdown()
    {
        Release("shutdown");
        uint tid;
        Thread? t;
        lock (_lock)
        {
            tid = _hookThreadId;
            t = _hookThread;
            _hookThreadId = 0;
            _hookThread = null;
            _hooksInstalled = false;
        }
        if (tid != 0)
        {
            try { PostThreadMessage(tid, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch { }
        }
        try { t?.Join(1000); } catch { }
    }

    private static void ForceRelease(string reason)
    {
        try
        {
            bool didRelease = false;
            lock (_lock)
            {
                if (_engaged) { _engaged = false; didRelease = true; }
            }
            if (didRelease) _onAutoRelease?.Invoke(reason);
        }
        catch { /* best effort */ }
    }

    private static bool EnsureHookThread()
    {
        if (_hooksInstalled && _hookThread is { IsAlive: true }) return true;

        _hooksReady.Reset();
        _mouseProc = MouseHookCallback;
        _kbProc = KeyboardHookCallback;

        var t = new Thread(HookThreadProc)
        {
            IsBackground = true,
            Name = "connectlive-hook-pump",
        };
        t.SetApartmentState(ApartmentState.STA);
        _hookThread = t;
        t.Start();

        // Wait up to 2s for the thread to install both hooks.
        if (!_hooksReady.Wait(2000))
        {
            Log.Warn("hook thread failed to signal ready");
            return false;
        }
        return _hooksInstalled;
    }

    private static void HookThreadProc()
    {
        try
        {
            var hMod = GetModuleHandle(null);
            _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc!, hMod, 0);
            _kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, _kbProc!, hMod, 0);
            if (_mouseHook == IntPtr.Zero || _kbHook == IntPtr.Zero)
            {
                Log.Warn($"SetWindowsHookEx failed (err={Marshal.GetLastWin32Error()})");
                _hooksInstalled = false;
                _hooksReady.Set();
                return;
            }
            _hookThreadId = GetCurrentThreadId();
            _hooksInstalled = true;
            _hooksReady.Set();

            // Blocking Win32 message pump. Exits on WM_QUIT from Shutdown().
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"hook thread crashed: {ex.Message}");
        }
        finally
        {
            try { if (_mouseHook != IntPtr.Zero) UnhookWindowsHookEx(_mouseHook); } catch { }
            try { if (_kbHook != IntPtr.Zero) UnhookWindowsHookEx(_kbHook); } catch { }
            _mouseHook = IntPtr.Zero;
            _kbHook = IntPtr.Zero;
            _hooksInstalled = false;
        }
    }

    // ---- Hook callbacks --------------------------------------------------
    // Must stay purely synchronous and extremely lightweight. Windows enforces
    // LowLevelHooksTimeout (default ~300ms, HKCU\Control Panel\Desktop) and
    // will silently drop / bypass slow callbacks. NO I/O, NO locks beyond the
    // single volatile read of _engaged, NO string formatting.

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == HC_ACTION && _engaged)
        {
            var hs = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            bool ours = hs.dwExtraInfo == CONNECTLIVE_INPUT_MAGIC;
            if (!ours)
            {
                // Physical user (or third-party synthetic without our sig) — swallow.
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == HC_ACTION && _engaged)
        {
            var hs = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            bool ours = hs.dwExtraInfo == CONNECTLIVE_INPUT_MAGIC;
            bool injected = (hs.flags & LLKHF_INJECTED_MASK) != 0;
            bool down = wParam.ToInt64() is 0x100 or 0x104;
            if (EscapeGesture.Feed(hs.vkCode, down, injected || ours))
            {
                // Unpause immediately. Disk/network/UI work is never performed
                // inside a low-level hook callback.
                _engaged = false;
                _localStopPending = true;
                EscapeGesture.Reset();
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try { LocalAccessState.Disable(); StartupConsent.Clear(); } catch { }
                    try { _onAutoRelease?.Invoke("local_emergency_stop"); } catch { }
                    try { LocalStopRequested?.Invoke(); } catch { }
                });
                return (IntPtr)1;
            }
            if (!ours)
            {
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }
}
