using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace ConnectLive.Unlock;

/// <summary>Local-only, length-prefixed IPC. Never logs or formats request bodies.</summary>
internal static class UnlockPipe
{
    internal const string BrokerName = "ConnectLive.WindowsUnlock.v1";
    internal const int MaxFrameBytes = 6 * 1024 * 1024;
    private const int MaxRequestBytes = 8192;
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode,
        uint instances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, int flags, StringBuilder path, ref int size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenService(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool QueryServiceStatusEx(IntPtr service, int level, [Out] uint[] status, int size, out int needed);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);

    internal static NamedPipeServerStream Listen(string name)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)", 1, out var descriptor, out _))
            throw new IOException("unlock_pipe_security");
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreateNamedPipe(@"\\.\pipe\" + name,
                0x3 | 0x40000000 | 0x00080000 /* duplex, overlapped, first instance */,
                0x8 /* PIPE_REJECT_REMOTE_CLIENTS */, 1, 65536, 65536, 0, ref attributes);
            if (handle.IsInvalid) { handle.Dispose(); throw new IOException("unlock_pipe_unavailable"); }
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally { LocalFree(descriptor); }
    }
    internal static int ClientPid(NamedPipeServerStream stream) =>
        GetNamedPipeClientProcessId(stream.SafePipeHandle, out var pid) ? checked((int)pid) : throw new IOException("unlock_client_unknown");

    internal static string ProcessSid(Process process)
    {
        if (!OpenProcessToken(process.Handle, 0x8 /* TOKEN_QUERY */, out var token)) throw new IOException("unlock_identity_unknown");
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
            return identity.User?.Value ?? throw new IOException("unlock_identity_unknown");
    }
    internal static string ProtectedPath(string file)
    {
        var expected = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "ConnectLive", file));
        // Reject junctions/reparse points at every ancestor, not just the leaf.
        for (var path = expected; !string.IsNullOrEmpty(path); path = Path.GetDirectoryName(path))
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("unlock_untrusted_path");
        AssertProtected(expected);
        AssertProtected(Path.GetDirectoryName(expected)!);
        AssertProtected(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        return expected;
    }
    internal static void AssertProtected(string path)
    {
        FileSystemSecurity acl = Directory.Exists(path)
            ? FileSystemAclExtensions.GetAccessControl(new DirectoryInfo(path))
            : FileSystemAclExtensions.GetAccessControl(new FileInfo(path));
        var installer = (SecurityIdentifier)new NTAccount("NT SERVICE", "TrustedInstaller").Translate(typeof(SecurityIdentifier));
        bool Trusted(string sid) => sid is "S-1-5-18" or "S-1-5-32-544" || sid == installer.Value;
        if (!Trusted(acl.GetOwner(typeof(SecurityIdentifier)).Value)) throw new IOException("unlock_untrusted_owner");
        const FileSystemRights writes = FileSystemRights.WriteData | FileSystemRights.AppendData |
            FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes | FileSystemRights.Delete |
            FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == AccessControlType.Allow &&
                (rule.PropagationFlags & PropagationFlags.InheritOnly) == 0 &&
                (rule.FileSystemRights & writes) != 0 && !Trusted(rule.IdentityReference.Value))
                throw new IOException("unlock_writable_installation");
    }
    private static int ServicePid()
    {
        var manager = OpenSCManager(null, null, 1 /* CONNECT */);
        if (manager == IntPtr.Zero) throw new IOException("unlock_service_unavailable");
        try
        {
            var service = OpenService(manager, "ConnectLiveUnlock", 4 /* QUERY_STATUS */);
            if (service == IntPtr.Zero) throw new IOException("unlock_service_unavailable");
            try
            {
                var status = new uint[9];
                if (!QueryServiceStatusEx(service, 0, status, 36, out _) || status[1] != 4)
                    throw new IOException("unlock_service_unavailable");
                return checked((int)status[7]);
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    internal static async Task<NamedPipeClientStream> ConnectAsync(string name, CancellationToken ct, int helperPid = 0)
    {
        if (name != BrokerName && !System.Text.RegularExpressions.Regex.IsMatch(name, @"^ConnectLive\.UnlockSession\.[0-9a-f]{32}$"))
            throw new IOException("unlock_pipe_invalid");
        var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous,
            TokenImpersonationLevel.Impersonation);
        try
        {
            await pipe.ConnectAsync(1500, ct).ConfigureAwait(false);
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var id)) throw new IOException("unlock_server_unknown");
            int expectedPid = name == BrokerName ? ServicePid() : helperPid;
            if (expectedPid <= 0 || id != expectedPid) throw new IOException("unlock_untrusted_server");
            // Query-limited access works from the unelevated Agent. Do not
            // require opening a LocalSystem process with PROCESS_ALL_ACCESS.
            using var process = OpenProcess(0x1000, false, expectedPid);
            var path = new StringBuilder(32768); int size = path.Capacity;
            if (process.IsInvalid || !QueryFullProcessImageName(process, 0, path, ref size) ||
                !string.Equals(path.ToString(), ProtectedPath("ConnectLiveUnlock.exe"), StringComparison.OrdinalIgnoreCase))
                throw new IOException("unlock_untrusted_server");
            return pipe;
        }
        catch { pipe.Dispose(); throw; }
    }
    internal static async Task WriteAsync(Stream stream, object value, CancellationToken ct, bool frame = false)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            if (bytes.Length > (frame ? MaxFrameBytes : MaxRequestBytes)) throw new IOException("unlock_message_too_large");
            await stream.WriteAsync(BitConverter.GetBytes(bytes.Length), ct).ConfigureAwait(false);
            await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes); }
    }
    internal static async Task<JsonDocument> ReadAsync(Stream stream, CancellationToken ct, bool frame = false)
    {
        var header = new byte[4];
        await stream.ReadExactlyAsync(header, ct).ConfigureAwait(false);
        int length = BitConverter.ToInt32(header, 0);
        if (length < 2 || length > (frame ? MaxFrameBytes : MaxRequestBytes)) throw new IOException("unlock_message_too_large");
        var bytes = new byte[length];
        try
        {
            await stream.ReadExactlyAsync(bytes, ct).ConfigureAwait(false);
            // The ReadOnlyMemory overload retains its input, so use the stream
            // overload to give JsonDocument its own buffer before clearing ours.
            using var input = new MemoryStream(bytes, writable: false);
            return JsonDocument.Parse(input);
        }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes); }
    }
}
