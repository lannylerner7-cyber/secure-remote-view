using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace ConnectLive.Unlock;

/// <summary>Windows 10/11 only. Unknown is never equivalent to unlocked.</summary>
internal static class WindowsSession
{
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int infoClass,
        out IntPtr buffer, out int length);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);

    internal static int CurrentId => Process.GetCurrentProcess().SessionId;
    internal static bool? Locked(int session)
    {
        if (session <= 0 || !OperatingSystem.IsWindowsVersionAtLeast(10)) return null;
        if (!WTSQuerySessionInformationW(IntPtr.Zero, session, 25 /* WTSSessionInfoEx */, out var data, out var length))
            return null;
        try
        {
            // WTSINFOEXW: DWORD Level; 8-aligned union WTSINFOEX_LEVEL1_W.
            // Level1 begins DWORD SessionId, WTS_CONNECTSTATE_CLASS, LONG flags.
            if (length < 20 || Marshal.ReadInt32(data, 0) != 1 || Marshal.ReadInt32(data, 8) != session) return null;
            var state = Marshal.ReadInt32(data, 12);
            var flags = Marshal.ReadInt32(data, 16);
            if (state != 0 /* WTSActive */) return null;
            return flags == 0 ? true : flags == 1 ? false : null;
        }
        finally { WTSFreeMemory(data); }
    }
}
