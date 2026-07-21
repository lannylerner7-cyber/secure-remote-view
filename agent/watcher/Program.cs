using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace ConnectLive.Watcher;

// -----------------------------------------------------------------------------
// ConnectLive Watcher
// -----------------------------------------------------------------------------
// Runs as LocalSystem via `sc create ConnectLiveWatcher`. Session 0 isolation
// prevents this process from capturing the screen or injecting input directly
// — so its only jobs are:
//
//   1. Survive reboots (auto-start service).
//   2. Detect the active interactive user session (WTSGetActiveConsoleSessionId).
//   3. Spawn ConnectLiveAgent.exe INTO that session, inheriting the user token
//      (CreateProcessAsUser). The Worker owns the actual capture/input relay.
//   4. Restart the Worker with capped backoff if it exits.
//
// If nobody is logged in (lock screen / boot-to-login), sessionId == 0xFFFFFFFF
// and we idle — no worker spawn until a real user desktop exists.
// -----------------------------------------------------------------------------
public static class Program
{
    public static async Task Main(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddWindowsService(o => o.ServiceName = "ConnectLiveWatcher");
        builder.Services.AddHostedService<WatcherService>();
        await builder.Build().RunAsync();
    }
}

internal sealed class WatcherService : BackgroundService
{
    private Process? _worker;
    private uint _lastSessionId = 0xFFFFFFFF;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var workerPath = Path.Combine(AppContext.BaseDirectory, "ConnectLiveAgent.exe");
        int backoffMs = 1000;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                uint sid = WinApi.WTSGetActiveConsoleSessionId();
                if (sid == 0xFFFFFFFF)
                {
                    // No interactive user (locked / boot). Idle without spawning.
                    KillWorker();
                    await Task.Delay(2000, ct);
                    continue;
                }

                // User switched (fast-user-switch): restart worker in the new session.
                if (sid != _lastSessionId)
                {
                    KillWorker();
                    _lastSessionId = sid;
                }

                if (_worker is null || _worker.HasExited)
                {
                    if (File.Exists(workerPath) && WinApi.LaunchInSession(sid, workerPath, out var proc))
                    {
                        _worker = proc;
                        backoffMs = 1000;                       // reset on success
                    }
                    else
                    {
                        await Task.Delay(backoffMs, ct);
                        backoffMs = Math.Min(30_000, backoffMs * 2);
                        continue;
                    }
                }

                await Task.Delay(2000, ct);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                EventLog.WriteEntry("ConnectLiveWatcher", ex.ToString(), EventLogEntryType.Warning);
                await Task.Delay(backoffMs, ct);
                backoffMs = Math.Min(30_000, backoffMs * 2);
            }
        }

        KillWorker();
    }

    private void KillWorker()
    {
        try { if (_worker is { HasExited: false }) _worker.Kill(entireProcessTree: true); } catch { }
        _worker = null;
    }
}

// -----------------------------------------------------------------------------
// Win32 interop — token duplication + CreateProcessAsUser
// -----------------------------------------------------------------------------
internal static class WinApi
{
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint SessionId, out IntPtr phToken);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess,
        IntPtr lpTokenAttributes, int SecurityImpersonationLevel, int TokenType, out IntPtr phNewToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);
    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr hToken, string? lpApplicationName,
        string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const uint TOKEN_ALL_ACCESS = 0x000F01FF;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NEW_CONSOLE = 0x00000010;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId;
    }

    /// <summary>
    /// Launch <paramref name="exePath"/> inside the interactive user session
    /// identified by <paramref name="sessionId"/>. Returns a Process handle
    /// we can watch for exit.
    /// </summary>
    public static bool LaunchInSession(uint sessionId, string exePath, out Process? process)
    {
        process = null;
        IntPtr userToken = IntPtr.Zero, dupToken = IntPtr.Zero, envBlock = IntPtr.Zero;
        try
        {
            if (!WTSQueryUserToken(sessionId, out userToken)) return false;
            if (!DuplicateTokenEx(userToken, TOKEN_ALL_ACCESS, IntPtr.Zero,
                    SecurityImpersonation, TokenPrimary, out dupToken)) return false;
            if (!CreateEnvironmentBlock(out envBlock, dupToken, false)) envBlock = IntPtr.Zero;

            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = @"winsta0\default" };
            uint flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE;
            if (!CreateProcessAsUser(dupToken, exePath, $"\"{exePath}\"", IntPtr.Zero, IntPtr.Zero,
                    false, flags, envBlock, Path.GetDirectoryName(exePath), ref si, out var pi))
                return false;

            try { process = Process.GetProcessById(pi.dwProcessId); } catch { }
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            return true;
        }
        finally
        {
            if (envBlock != IntPtr.Zero) DestroyEnvironmentBlock(envBlock);
            if (dupToken != IntPtr.Zero) CloseHandle(dupToken);
            if (userToken != IntPtr.Zero) CloseHandle(userToken);
        }
    }
}
