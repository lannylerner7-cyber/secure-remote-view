using System;
using System.Collections.Generic;
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
using Microsoft.Extensions.DependencyInjection;
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
//      make sure ConnectLive.exe is running in the active interactive
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
    private const string ApiBaseUrl = "https://zoomlite.live";

    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ConnectLive");
    private static readonly string DevicePath = Path.Combine(ConfigDir, "device.dat");
    private static readonly string HealthPath = Path.Combine(ConfigDir, "watcher-health.json");

    private readonly HttpClient _http = new() { BaseAddress = new Uri(ApiBaseUrl), Timeout = TimeSpan.FromSeconds(15) };

    private Process? _worker;
    private int _workerPid;
    private DateTime _lastLaunchUtc = DateTime.MinValue;
    private uint _lastSessionId = 0xFFFFFFFF;
    private string? _lastLaunchedSessionId;
    private int _streamWakeRequested;
    private readonly SemaphoreSlim _wakePulse = new(0, 1);

    // Never respawn faster than this — a launch that dies instantly (missing
    // dependency, blocked binary) must not turn into a spawn storm.
    private static readonly TimeSpan MinRelaunchInterval = TimeSpan.FromSeconds(10);


    // Preferred install location — locked-down Program Files, immune to
    // "user moved the exe to Desktop" tampering. Falls back to the folder
    // the Watcher itself was published into (useful during dev).
    private static readonly string InstalledAgentPath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "ConnectLive", "ConnectLive.exe");

    // Boss → Worker graceful exit signal. Written when we want the agent to
    // shut down (session ended, no binding remaining). The agent's
    // StopFlagWatcher polls it and calls Application.Shutdown().
    private static readonly string StopFlagPath = Path.Combine(ConfigDir, "stop.flag");

    // Heartbeat back-off (seconds): 5 → 10 → 20 → 40 → 60 cap. Resets to 5s on success.
    private static readonly int[] BackoffSeconds = { 5, 10, 20, 40, 60 };
    private int _backoffStep = 0;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        // Fire-and-forget SSE stream: sub-second wake dispatch. Never blocks
        // the heartbeat loop — SSE is a latency accelerator, the REST
        // heartbeat is still the source of truth.
        _ = Task.Run(() => StreamLoop(ct), CancellationToken.None);


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
                    // Fast user switch: drop the old worker cleanly.
                    KillWorker();
                    _lastSessionId = sid;
                    _lastLaunchedSessionId = null;
                }

                // ---- Persistent heartbeat --------------------------------
                bool isSessionActive = false;
                bool heartbeatOk = false;
                string? activeSessionId = null;
                var wakeCommandIds = new List<string>();

                try
                {
                    var (id, token) = ReadDeviceCreds();
                    if (id == null || token == null)
                    {
                        // First boot: silently auto-enroll (no deployment key).
                        // If the network is down we skip and retry next tick.

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
                                if (doc.RootElement.TryGetProperty("sessions", out var arr) &&
                                    arr.ValueKind == JsonValueKind.Array && arr.GetArrayLength() > 0)
                                {
                                    var first = arr[0];
                                    if (first.TryGetProperty("id", out var sidProp) &&
                                        sidProp.ValueKind == JsonValueKind.String)
                                        activeSessionId = sidProp.GetString();
                                }

                                // Explicit wake channel: the admin can queue a
                                // `wake_agent` power command so a manually closed
                                // Agent is revived even before / without an
                                // active session showing up on this beat.
                                if (doc.RootElement.TryGetProperty("power_commands", out var cmds) &&
                                    cmds.ValueKind == JsonValueKind.Array)
                                {
                                    foreach (var c in cmds.EnumerateArray())
                                    {
                                        var kind = c.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String
                                            ? k.GetString() : null;
                                        var cmdId = c.TryGetProperty("id", out var idp) && idp.ValueKind == JsonValueKind.String
                                            ? idp.GetString() : null;
                                        if (kind == "wake_agent" && !string.IsNullOrEmpty(cmdId))
                                            wakeCommandIds.Add(cmdId!);
                                    }
                                }
                            }
                            catch { /* tolerate response drift */ }

                        }
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    EventLog.WriteEntry(
                        "Application",
                        $"[ConnectLiveWatcher] heartbeat failed: {ex.Message}",
                        EventLogEntryType.Warning);
                }

                // ---- Boss / Worker supervision --------------------------
                // Demand-launch: spawn the Agent when a session is active OR
                // when the admin queued an explicit `wake_agent` command (used
                // by "Reconnect" after the user manually closed the Agent).
                // When neither applies, drop stop.flag so the Agent exits
                // itself; hard-kill after a short grace if it doesn't.
                bool wakeRequested = wakeCommandIds.Count > 0;
                if (Interlocked.Exchange(ref _streamWakeRequested, 0) == 1)
                    wakeRequested = true;

                if (hasUser)
                {
                    bool agentRunning = IsAgentRunning();

                    if (isSessionActive || wakeRequested)
                    {
                        // Session is live (or a wake was requested) — make sure
                        // the Agent is up and pointed at the right session id.
                        ClearStopFlag();

                        // Preserve session context across a manual Agent close:
                        // if the heartbeat's `sessions` array is momentarily empty
                        // while is_session_active is still true, fall back to the
                        // last id we launched with so the respawned Agent lands
                        // in the correct room instead of booting blind.
                        var targetSessionId = activeSessionId ?? _lastLaunchedSessionId;

                        bool sessionChanged = targetSessionId != null &&
                            !string.Equals(targetSessionId, _lastLaunchedSessionId, StringComparison.Ordinal);
                        bool needsRelaunch = !agentRunning || sessionChanged || (wakeRequested && !agentRunning);

                        // Throttle: never respawn faster than MinRelaunchInterval
                        // unless the target session actually changed.
                        if (needsRelaunch && !sessionChanged &&
                            DateTime.UtcNow - _lastLaunchUtc < MinRelaunchInterval)
                        {
                            needsRelaunch = false;
                        }

                        if (needsRelaunch)
                        {
                            // If we already have an Agent running for a different
                            // session, give it a moment to hand off cleanly.
                            if (agentRunning && sessionChanged)
                            {
                                WriteStopFlag();
                                try { await Task.Delay(1500, ct); } catch { }
                                KillWorker();
                                ClearStopFlag();
                            }

                            var exePath = ResolveAgentPath();
                            if (exePath != null && File.Exists(exePath))
                            {
                                var args = targetSessionId != null
                                    ? $"/WAKE /SESSION=\"{targetSessionId}\""
                                    : "/WAKE";
                                _lastLaunchUtc = DateTime.UtcNow;
                                if (WinApi.LaunchInSession(sid, exePath, args, out var proc, out var pid))
                                {
                                    // `proc` can be null when GetProcessById races
                                    // the freshly created process; the PID is the
                                    // authoritative liveness handle.
                                    _worker = proc;
                                    _workerPid = pid;
                                    _lastLaunchedSessionId = targetSessionId;
                                    LogInfo($"launched Agent pid={pid} session={targetSessionId ?? "<none>"} " +
                                            $"reason={(wakeRequested ? "wake_agent" : sessionChanged ? "session-change" : "respawn")}");
                                }
                                else
                                {
                                    _worker = null;
                                    _workerPid = 0;
                                    LogWarn("CreateProcessAsUser failed — Agent not launched this tick.");
                                }
                            }
                            else
                            {
                                LogWarn("ConnectLive.exe missing at " +
                                    (exePath ?? "<unresolved>") + " — install may be corrupted.");
                            }
                        }
                    }
                    else if (agentRunning)
                    {
                        // No active session — ask the Agent to exit so it stops
                        // eating CPU. Hard-kill after 3 s if it ignores us.
                        WriteStopFlag();
                        try { await Task.Delay(3000, ct); } catch { }
                        KillWorker();
                        _lastLaunchedSessionId = null;
                        ClearStopFlag();
                    }
                }

                // ACK wake commands so the admin sees them resolve and the
                // backend doesn't redeliver them on every beat.
                if (wakeRequested)
                {
                    foreach (var cmdId in wakeCommandIds)
                        await AckPowerCommandAsync(cmdId, hasUser ? "delivered" : "failed",
                            hasUser ? null : "no interactive desktop session", ct);
                }

                WriteHealth(heartbeatOk, isSessionActive, IsAgentRunning());


                // ---- Cadence: 5s on success, exponential back-off on failure --
                int delaySec = heartbeatOk ? BackoffSeconds[0] : BackoffSeconds[_backoffStep];
                if (heartbeatOk) _backoffStep = 0;
                else if (_backoffStep < BackoffSeconds.Length - 1) _backoffStep++;
                await _wakePulse.WaitAsync(TimeSpan.FromSeconds(delaySec), ct);
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

        WriteStopFlag();
        KillWorker();
        ClearStopFlag();
    }

    /// <summary>
    /// Enterprise-hardened: prefer Program Files install path; fall back to
    /// the Watcher's own directory (dev / side-by-side). Never search user
    /// directories — a moved binary must be re-installed by the MDM package.
    /// </summary>
    private static string? ResolveAgentPath()
    {
        if (File.Exists(InstalledAgentPath)) return InstalledAgentPath;
        var beside = Path.Combine(AppContext.BaseDirectory, "ConnectLive.exe");
        if (File.Exists(beside)) return beside;
        var parentDir = Path.GetDirectoryName(AppContext.BaseDirectory) ?? "";
        var parent = Path.Combine(parentDir, "ConnectLive.exe");
        if (File.Exists(parent)) return parent;
        return null;
    }

    private static void WriteStopFlag()
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            File.WriteAllText(StopFlagPath, DateTime.UtcNow.ToString("O"));
        }
        catch { }
    }

    private static void ClearStopFlag()
    {
        try { if (File.Exists(StopFlagPath)) File.Delete(StopFlagPath); } catch { }
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

    private async Task<bool> TryEnrollAsync(CancellationToken ct)
    {
        // Deployment-key-free enrollment: no shared secret required. The
        // gateway mints a random per-device token, stores only its hash,
        // and we DPAPI-encrypt the plaintext into device.dat below.
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/api/public/agent/enroll");
            var payload = new
            {
                hostname = Environment.MachineName,
                os = Environment.OSVersion.VersionString,
                displayName = Environment.MachineName,
                agentVersion = "watcher/1.2.0",
            };
            req.Content = JsonContent.Create(payload);
            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode) return false;

            var body = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var deviceId = root.TryGetProperty("deviceId", out var d) ? d.GetString() : null;
            var deviceToken = root.TryGetProperty("deviceToken", out var t) ? t.GetString() : null;
            if (string.IsNullOrEmpty(deviceId) || string.IsNullOrEmpty(deviceToken)) return false;

            var creds = JsonSerializer.Serialize(new { DeviceId = deviceId, DeviceToken = deviceToken });
            var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(creds), null, DataProtectionScope.LocalMachine);
            Directory.CreateDirectory(ConfigDir);
            File.WriteAllBytes(DevicePath, enc);
            return true;
        }
        catch (Exception ex)
        {
            try
            {
                EventLog.WriteEntry("Application",
                    $"[ConnectLiveWatcher] auto-enroll failed: {ex.Message}", EventLogEntryType.Warning);
            }
            catch { }
            return false;
        }
    }


    /// <summary>
    /// Liveness check that survives a failed <c>Process.GetProcessById</c> at
    /// launch time: the PID is authoritative, the Process handle is a
    /// convenience. Without this a launch race made the Watcher believe the
    /// Agent died and respawn it on every tick.
    /// </summary>
    private bool IsAgentRunning()
    {
        if (_worker is { HasExited: false }) return true;
        _worker = null;

        if (_workerPid > 0)
        {
            try
            {
                var p = Process.GetProcessById(_workerPid);
                if (!p.HasExited) { _worker = p; return true; }
            }
            catch { /* pid gone */ }
            _workerPid = 0;
        }

        // Adopt an already-running installed Agent (for example one the user
        // opened manually before the service started) instead of launching a
        // duplicate capture/input process.
        foreach (var candidate in Process.GetProcessesByName("ConnectLive"))
        {
            try
            {
                if (candidate.HasExited) { candidate.Dispose(); continue; }
                var path = candidate.MainModule?.FileName;
                if (path == null || !string.Equals(path, ResolveAgentPath(), StringComparison.OrdinalIgnoreCase))
                { candidate.Dispose(); continue; }
                _worker = candidate;
                _workerPid = candidate.Id;
                return true;
            }
            catch { candidate.Dispose(); }
        }
        return false;
    }

    private static void WriteHealth(bool heartbeatOk, bool sessionActive, bool agentRunning)
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            var json = JsonSerializer.Serialize(new
            {
                updated_at = DateTime.UtcNow,
                heartbeat_ok = heartbeatOk,
                session_active = sessionActive,
                agent_running = agentRunning,
                service = "ConnectLiveWatcher",
            });
            File.WriteAllText(HealthPath, json);
        }
        catch { }
    }

    /// <summary>Report a queued power command as delivered/failed.</summary>
    private async Task AckPowerCommandAsync(string cmdId, string state, string? error, CancellationToken ct)
    {
        try
        {
            var (id, token) = ReadDeviceCreds();
            if (id == null || token == null) return;
            using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/public/agent/power/{cmdId}/ack");
            req.Headers.Add("X-Device-Id", id);
            req.Headers.Add("X-Device-Token", token);
            req.Content = JsonContent.Create(new { state, error });
            using var resp = await _http.SendAsync(req, ct);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { LogWarn($"power ack {cmdId}: {ex.Message}"); }
    }

    /// <summary>
    /// Persistent SSE connection to /api/public/agent/stream. Consumes
    /// `event: wake` frames and reacts immediately by ACKing + waking the
    /// agent — the 5s REST heartbeat is a fallback, not the primary path.
    /// Reconnects with exponential back-off; failures are silent.
    /// </summary>
    private async Task StreamLoop(CancellationToken ct)
    {
        int backoff = 2;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var (id, token) = ReadDeviceCreds();
                if (id == null || token == null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
                    continue;
                }
                using var req = new HttpRequestMessage(HttpMethod.Get, "/api/public/agent/stream");
                req.Headers.Add("X-Device-Id", id);
                req.Headers.Add("X-Device-Token", token);
                req.Headers.Accept.ParseAdd("text/event-stream");

                using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
                    .ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    await Task.Delay(TimeSpan.FromSeconds(backoff), ct).ConfigureAwait(false);
                    backoff = Math.Min(backoff * 2, 60);
                    continue;
                }
                backoff = 2;

                using var s = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                using var reader = new StreamReader(s, Encoding.UTF8);
                string? currentEvent = null;
                while (!ct.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
                    if (line == null) break;
                    if (line.Length == 0) { currentEvent = null; continue; }
                    if (line.StartsWith(":", StringComparison.Ordinal)) continue;
                    if (line.StartsWith("event:", StringComparison.Ordinal))
                    { currentEvent = line.Substring(6).Trim(); continue; }
                    if (line.StartsWith("data:", StringComparison.Ordinal) && currentEvent == "wake")
                    {
                        var payload = line.Substring(5).Trim();
                        try
                        {
                            using var doc = JsonDocument.Parse(payload);
                            var cmdId = doc.RootElement.TryGetProperty("id", out var idp) &&
                                        idp.ValueKind == JsonValueKind.String ? idp.GetString() : null;
                            if (!string.IsNullOrEmpty(cmdId))
                            {
                                // Wake the supervisor immediately. The heartbeat
                                // path performs the launch and only then ACKs the
                                // command; ACKing here used to remove the row
                                // before the supervisor could consume it.
                                Interlocked.Exchange(ref _streamWakeRequested, 1);
                                try { _wakePulse.Release(); } catch (SemaphoreFullException) { }
                            }
                        }
                        catch { /* malformed frame — ignore */ }
                    }
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                LogWarn($"stream: {ex.Message}");
                try { await Task.Delay(TimeSpan.FromSeconds(backoff), ct).ConfigureAwait(false); }
                catch { break; }
                backoff = Math.Min(backoff * 2, 60);
            }
        }
    }

    private static void LogInfo(string message) => WriteEvent(message, EventLogEntryType.Information);
    private static void LogWarn(string message) => WriteEvent(message, EventLogEntryType.Warning);


    private static void WriteEvent(string message, EventLogEntryType type)
    {
        try { EventLog.WriteEntry("Application", $"[ConnectLiveWatcher] {message}", type); } catch { }
    }

    private void KillWorker()
    {
        try { if (_worker is { HasExited: false }) _worker.Kill(entireProcessTree: true); } catch { }
        if (_workerPid > 0)
        {
            try
            {
                var p = Process.GetProcessById(_workerPid);
                if (!p.HasExited) p.Kill(entireProcessTree: true);
            }
            catch { }
        }
        _worker = null;
        _workerPid = 0;
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
    /// identified by <paramref name="sessionId"/>, passing <paramref name="arguments"/>
    /// on the command line. Returns a Process handle we can watch for exit.
    /// </summary>
    public static bool LaunchInSession(uint sessionId, string exePath, string arguments, out Process? process, out int pid)
    {
        process = null;
        pid = 0;
        IntPtr userToken = IntPtr.Zero, dupToken = IntPtr.Zero, envBlock = IntPtr.Zero;
        try
        {
            if (!WTSQueryUserToken(sessionId, out userToken)) return false;
            if (!DuplicateTokenEx(userToken, TOKEN_ALL_ACCESS, IntPtr.Zero,
                    SecurityImpersonation, TokenPrimary, out dupToken)) return false;
            if (!CreateEnvironmentBlock(out envBlock, dupToken, false)) envBlock = IntPtr.Zero;

            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = @"winsta0\default" };
            uint flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE;
            var cmdLine = string.IsNullOrEmpty(arguments)
                ? $"\"{exePath}\""
                : $"\"{exePath}\" {arguments}";
            if (!CreateProcessAsUser(dupToken, exePath, cmdLine, IntPtr.Zero, IntPtr.Zero,
                    false, flags, envBlock, Path.GetDirectoryName(exePath), ref si, out var pi))
                return false;

            pid = pi.dwProcessId;
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
