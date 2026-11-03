using System.ComponentModel;
using System.Runtime.InteropServices;

namespace ConnectLive.Updates;

public static class DurableFile
{
    public static void Replace(string source, string destination)
    {
        if (!OperatingSystem.IsWindows()) { File.Move(source, destination, true); return; }
        // Flush the rename as well as the file contents. A durable journal
        // transition must precede the next installed-file replacement.
        if (!MoveFileEx(source, destination, 0x1 | 0x8))
            throw new IOException("Atomic update move failed", new Win32Exception(Marshal.GetLastWin32Error()));
    }

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string source, string destination, uint flags);
}
