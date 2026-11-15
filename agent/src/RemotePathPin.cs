using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ConnectLive.Agent;

/// <summary>Windows directory handles deny write/delete/reparse replacement for an operation.</summary>
internal sealed class RemotePathPin : IDisposable
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    private readonly List<SafeFileHandle> _handles = new();
    internal RemotePathPin(string directory)
    {
        if (!OperatingSystem.IsWindows()) return; // portable tests do not certify Windows sharing.
        var paths = new Stack<string>();
        for (string? path = Path.GetFullPath(directory); path != null; path = Path.GetDirectoryName(path)) paths.Push(path);
        try
        {
            while (paths.TryPop(out var path))
            {
                // OPEN_REPARSE_POINT means no link is traversed during the open;
                // the subsequent attribute check is stable under this handle.
                var handle = CreateFile(path, 0x80, 1, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
                if (handle.IsInvalid) { handle.Dispose(); throw new IOException("folder_busy_or_permission_denied"); }
                _handles.Add(handle);
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("reparse_path_denied");
            }
        }
        catch { Dispose(); throw; }
    }
    public void Dispose() { foreach (var handle in _handles) handle.Dispose(); _handles.Clear(); }
}
