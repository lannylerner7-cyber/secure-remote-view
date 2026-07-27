using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace ConnectLive.Watcher;

// -----------------------------------------------------------------------------
// ConnectLive Watcher — Double-Vouch control plane
// -----------------------------------------------------------------------------
// Runs as LocalSystem via `sc create ConnectLiveWatcher`. Two responsibilities:
//
//   1. Persistent Heartbeat (control plane): every 5s (exponential back-off on
//      failure, capped at 60s) POST /api/public/agent/heartbeat so the backend
//      knows this machine is alive across reboots and boot-time network delay.
//      The loop never exits on error — that's what solves "no IP yet" at boot.
//
//   2. Session Supervision: if the heartbeat response says is_session_active,
//      make sure ConnectLiveAgent.exe is running in the active interactive
//      user session. Session 0 isolation forces us to spawn via
//      CreateProcessAsUser; the agent owns capture/input relay from there.
//
// If nobody is logged in (WTSGetActiveConsoleSessionId == 0xFFFFFFFF), we
// idle without spawning until a real user desktop exists.
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
    // Must match ApiClient.DefaultApiBaseUrl in the agent.
    private const string ApiBaseUrl = "https://secure-remote-view.lovable.app";

    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ConnectLive");
    private static readonly string DevicePath = Path.Combine(ConfigDir, "device.dat");

    private readonly HttpClient _http = new() { BaseAddress = new Uri(ApiBaseUrl), Timeout = TimeSpan.FromSeconds(15) };

    private Process? _worker;
    private uint _lastSessionId = 0xFFFFFFFF;

    // Heartbeat back-off (seconds): 5 → 10 → 20 → 40 → 60 cap. Resets to 5s on success.
    private static readonly int[] BackoffSeconds = { 5, 10, 20, 40, 60 };
    private int _backoffStep = 0;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var workerPath = Path.Combine(AppContext.BaseDirectory, "ConnectLiveAgent.exe");

        while (!ct.IsCancellationRequested)
        {
            try
            {
                uint sid = WinApi.WTSGetActiveConsoleSessionId();
                bool hasUser = sid != 0xFFFFFFFF;

                if (!hasUser)
                {
                    // No interactive desktop yet. Still heartbeat so the backend
                    // records this machine as online across lock-screen boots.
                    KillWorker();
                }
                else if (sid != _lastSessionId)
                {
                    // Fast user switch: restart the worker in the new session.
                    KillWorker();
                    _lastSessionId = sid;
                }

                // ---- Persistent heartbeat --------------------------------
                bool isSessionActive = false;
                bool heartbeatOk = false;
                try
                {
                    var (id, token) = ReadDeviceCreds();
                    if (id == null || token == null)
                    {
                        // First boot: silently enroll with the deployment key.
                        // If the key isn't installed yet we skip and retry next tick.
                        var enrolled = await TryEnrollAsync(ct);
                        if (enrolled) (id, token) = ReadDeviceCreds();
                    }

                    if (id != null && token != null)
                    {
                        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/heartbeat");
                        req.Headers.Add("X-Device-Id", id);
                        req.Headers.Add("X-Device-Token", token);
                        using var resp = await _http.SendAsync(req, ct);
                        if (resp.IsSuccessStatusCode)
                        {
                            heartbeatOk = true;
                            var body = await resp.Content.ReadAsStringAsync(ct);
                            try
                            {
                                using var doc = JsonDocument.Parse(body);
                                if (doc.RootElement.TryGetProperty("is_session_active", out var flag))
                                    isSessionActive = flag.ValueKind == JsonValueKind.True;
                            }
                            catch { /* tolerate response drift */ }
                        }
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    // Network not up yet after reboot, or transient outage. Loop on.
                    EventLog.WriteEntry(
                        "Application",
                        $"[ConnectLiveWatcher] heartbeat failed: {ex.Message}",
                        EventLogEntryType.Warning);
                }

                // ---- Session supervision ---------------------------------
                if (hasUser)
                {
                    bool agentRunning = _worker is { HasExited: false };
                    if (!agentRunning) _worker = null;

                    // Spawn if the flag says a session is active, or on cold start
                    // when no worker is present (preserves the always-spawn-on-login
                    // UX so the tray icon appears right after boot).
                    if (_worker is null && File.Exists(workerPath) && (isSessionActive || true))
                    {
                        if (WinApi.LaunchInSession(sid, workerPath, out var proc))
                        {
                            _worker = proc;
                        }
                    }
                }

                // ---- Cadence: 5s on success, exponential back-off on failure --
                int delaySec = heartbeatOk ? BackoffSeconds[0] : BackoffSeconds[_backoffStep];
                if (heartbeatOk) _backoffStep = 0;
                else if (_backoffStep < BackoffSeconds.Length - 1) _backoffStep++;
                await Task.Delay(TimeSpan.FromSeconds(delaySec), ct);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                try
                {
                    EventLog.WriteEntry(
                        "Application",
                        $"[ConnectLiveWatcher] loop error: {ex}",
                        EventLogEntryType.Warning);
                }
                catch { }
                try { await Task.Delay(TimeSpan.FromSeconds(5), ct); } catch { break; }
            }
        }

        KillWorker();
    }

    private (string? id, string? token) ReadDeviceCreds()
    {
        try
        {
            if (!File.Exists(DevicePath)) return (null, null);
            var enc = File.ReadAllBytes(DevicePath);
            // Agent writes with DataProtectionScope.LocalMachine so SYSTEM can decrypt too.
            var dec = ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine);
            var json = Encoding.UTF8.GetString(dec);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            string? id = root.TryGetProperty("DeviceId", out var i) ? i.GetString() : null;
            string? tok = root.TryGetProperty("DeviceToken", out var t) ? t.GetString() : null;
            return (id, tok);
        }
        catch { return (null, null); }
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
