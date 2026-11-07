using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace ConnectLive.Unlock;

internal static class NativeProcess
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startup
    {
        public int Size; public string? Reserved, Desktop, Title;
        public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(SafeAccessTokenHandle token, uint access, IntPtr attributes, int level, int type, out SafeAccessTokenHandle duplicate);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(SafeAccessTokenHandle token, int information, ref int value, int length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(SafeAccessTokenHandle token, string application, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("sas.dll")] internal static extern void SendSAS([MarshalAs(UnmanagedType.Bool)] bool asUser);

    internal static Process StartDesktop(int clientPid, int sessionId, string pipe)
    {
        var path = UnlockPipe.ProtectedPath("ConnectLiveUnlock.exe");
        if (sessionId <= 0 || WindowsSession.Locked(sessionId) != true) throw new IOException("unlock_session_denied");
        using var current = Process.GetCurrentProcess();
        if (!OpenProcessToken(current.Handle, 0xF01FF, out var token)) throw new IOException("unlock_service_token");
        using (token)
        {
            if (!DuplicateTokenEx(token, 0xF01FF, IntPtr.Zero, 2, 1, out var primary)) throw new IOException("unlock_service_token");
            using (primary)
            {
                if (!SetTokenInformation(primary, 12 /* TokenSessionId */, ref sessionId, 4)) throw new IOException("unlock_session_token");
                var startup = new Startup { Size = Marshal.SizeOf<Startup>(), Desktop = @"winsta0\Winlogon" };
                // No caller-selected executable, arguments, desktop, working
                // directory, environment, or inherited handles.
                var command = new StringBuilder($"\"{path}\" --desktop {clientPid} {sessionId} {pipe}");
                if (!CreateProcessAsUser(primary, path, command, IntPtr.Zero, IntPtr.Zero, false,
                    0x08000000 /* CREATE_NO_WINDOW */, IntPtr.Zero, Path.GetDirectoryName(path)!, ref startup, out var info))
                    throw new IOException("unlock_helper_start");
                try { return Process.GetProcessById(info.Id); }
                finally { CloseHandle(info.Thread); CloseHandle(info.Process); }
            }
        }
    }
}
