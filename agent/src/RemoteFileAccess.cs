using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace ConnectLive.Agent;

internal sealed record RemoteFileEntry(string name, string path, bool directory, long size, string revision);
internal sealed record RemoteFilePage(string rootId, string path, RemoteFileEntry[] entries, string? next);

/// <summary>Ordinary user access only. No helper, UNC paths, links or recursion.</summary>
internal sealed class RemoteFileAccess : IDisposable
{
    private IEnumerator<string>? _listing;
    private RemotePathPin? _pin;
    private string? _cursor, _rootId, _relative;
    private long _expires;
    internal static void ValidateRoot(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal))
            throw new IOException("folder_not_approved");
        NoLinks(path);
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException();
    }
    private static void NoLinks(string path)
    {
        for (string? item = Path.GetFullPath(path); !string.IsNullOrEmpty(item); item = Path.GetDirectoryName(item))
            if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("reparse_path_denied");
    }
    internal static string Resolve(string root, string relative)
    {
        ValidateRoot(root);
        if (relative.Length > 1024 || Path.IsPathRooted(relative) ||
            relative.Contains(':') || relative.Contains('\\') ||
            relative.Split('/').Any(p => p is "." or ".." || p.EndsWith(' ') || p.EndsWith('.')))
            throw new IOException("path_denied");
        var full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        if (!string.Equals(full, prefix, StringComparison.OrdinalIgnoreCase) &&
            !full.StartsWith(prefix + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new IOException("path_denied");
        NoLinks(full);
        return full;
    }
    internal RemoteFilePage List(ApprovedFolder root, string relative, string? cursor, Func<bool> current)
    {
        if (!current()) throw new IOException("authorization_changed");
        var resolved = Resolve(root.Path, relative);
        if (cursor == null)
        {
            Dispose();
            _pin = new RemotePathPin(resolved);
            Resolve(root.Path, relative);
            _listing = Directory.EnumerateFileSystemEntries(resolved).GetEnumerator();
            _rootId = root.Id; _relative = relative;
        }
        else if (cursor != _cursor || root.Id != _rootId || relative != _relative || Environment.TickCount64 > _expires)
            throw new IOException("directory_page_expired");
        // STJ escapes non-ASCII by default. Bound the actual worst-case reply,
        // including deep paths, below the negotiated 64 KiB control message.
        int pageSize = Math.Max(4, Math.Min(100, 48_000 / (relative.Length * 6 + 3500)));
        var rows = new List<RemoteFileEntry>(pageSize);
        int examined = 0;
        while (rows.Count < pageSize && examined++ < 500 && _listing!.MoveNext())
        {
            if (!current()) { Dispose(); throw new IOException("authorization_changed"); }
            var name = Path.GetFileName(_listing.Current);
            string child = string.IsNullOrEmpty(relative) ? name : relative + "/" + name;
            try
            {
                var full = Resolve(root.Path, child);
                var attributes = File.GetAttributes(full);
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                var dir = (attributes & FileAttributes.Directory) != 0;
                var info = new FileInfo(full);
                rows.Add(new(name, child, dir, dir ? 0 : info.Length, dir ? "" : Revision(info)));
            }
            catch (IOException) { /* Changed/unreadable children are not exported. */ }
            catch (UnauthorizedAccessException) { }
        }
        if (rows.Count < pageSize && examined < 500) { Dispose(); return new(root.Id, relative, rows.ToArray(), null); }
        _expires = Environment.TickCount64 + 30_000;
        _cursor = Guid.NewGuid().ToString();
        return new(root.Id, relative, rows.ToArray(), _cursor);
    }
    internal static string Revision(FileInfo info) => $"{info.Length:x}-{info.LastWriteTimeUtc.Ticks:x}-{info.CreationTimeUtc.Ticks:x}";
    internal static ApprovedRead Open(ApprovedFolder root, string relative, string revision, long size)
    {
        string full = Resolve(root.Path, relative);
        var info = new FileInfo(full);
        if (info.Length != size || Revision(info) != revision || size > FileTransfer.MaxFileBytes)
            throw new IOException("file_changed");
        // FileShare.Read denies writes and deletion on Windows. Keep this handle
        // for hashing AND transmission; never reopen after the checksum pass.
        var pin = new RemotePathPin(Path.GetDirectoryName(full)!);
        FileStream stream;
        try { Resolve(root.Path, relative); stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true); }
        catch { pin.Dispose(); throw; }
        try
        {
            var read = new ApprovedRead(root.Path, relative, revision, stream, pin);
            read.Validate(); return read;
        }
        catch { stream.Dispose(); pin.Dispose(); throw; }
    }
    public void Dispose()
    {
        _listing?.Dispose(); _listing = null; _cursor = _rootId = _relative = null;
        _pin?.Dispose(); _pin = null;
    }
    internal sealed class ApprovedRead(string root, string relative, string revision, FileStream stream, RemotePathPin pin) : IDisposable
    {
        internal FileStream Stream => stream;
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder name, uint length, uint flags);
        internal void Validate()
        {
            var expected = Resolve(root, relative);
            var info = new FileInfo(expected);
            if (Revision(info) != revision || stream.Length != info.Length) throw new IOException("file_changed");
            if (OperatingSystem.IsWindows())
            {
                var name = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandle(stream.SafeFileHandle, name, (uint)name.Capacity, 0);
                if (length == 0 || length >= name.Capacity ||
                    !string.Equals(name.ToString().Replace(@"\\?\", ""), expected, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("file_path_changed");
            }
        }
        public void Dispose() { stream.Dispose(); pin.Dispose(); }
    }
}
