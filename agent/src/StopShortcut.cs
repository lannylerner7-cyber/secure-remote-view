using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Interop;

namespace ConnectLive.Agent;

/// <summary>
/// Ctrl+Alt+Shift+X stops the agent and withdraws local access, the same as
/// tray "Disable remote access". RegisterHotKey covers normal use; while the
/// curtain swallows physical keys the hotkey never reaches Windows, so
/// <see cref="InputBlocker"/> recognises the combo itself and calls
/// <see cref="Raise"/>.
/// </summary>
internal static class StopShortcut
{
    internal const string Label = "Ctrl + Alt + Shift + X";
    internal const uint Key = 0x58; // VK_X

    private const int HotkeyId = 0x434C;
    private const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_NOREPEAT = 0x4000;
    private const int WM_HOTKEY = 0x0312;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    private static HwndSource? _source;
    private static int _raised;

    /// <summary>Fires once, on a thread-pool thread.</summary>
    internal static event Action? Pressed;

    /// <summary>Call on the UI thread.</summary>
    internal static void Register()
    {
        if (_source != null) return;
        // Message-only window: never shown, only receives WM_HOTKEY.
        _source = new HwndSource(new HwndSourceParameters("ConnectLiveStopShortcut") { ParentWindow = new IntPtr(-3) });
        _source.AddHook(WndProc);
        if (!RegisterHotKey(_source.Handle, HotkeyId, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, Key))
            Log.Warn($"stop shortcut {Label} unavailable (error {Marshal.GetLastWin32Error()}); use the tray icon");
    }

    internal static void Raise()
    {
        if (Interlocked.Exchange(ref _raised, 1) != 0) return;
        ThreadPool.QueueUserWorkItem(_ => { try { Pressed?.Invoke(); } catch { } });
    }

    private static IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WM_HOTKEY && wParam.ToInt32() == HotkeyId)
        {
            Raise();
            handled = true;
        }
        return IntPtr.Zero;
    }
}
