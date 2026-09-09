using System;
using System.Diagnostics;
using System.IO;

namespace ConnectLive.Agent;

/// <summary>
/// Re-asserts the three redundant logon triggers every launch:
///   1. HKCU Run key            (delegated to StartupRegistration)
///   2. Startup folder shortcut (%APPDATA%\...\Startup\ConnectLive.lnk)
///   3. Scheduled Task          (ConnectLiveAgent, AtLogOn, /background)
///
/// Dev-path guard is preserved — if the running EXE is NOT the one in the
/// installed Program Files directory, all three checks are skipped so a
/// dev/Downloads build cannot clobber the machine's autostart entries.
///
/// Every operation is best-effort: individual failures log Warn and never
/// propagate. Each trigger is checked independently.
///
/// Flag casing MUST stay lowercase "/background" — matches the literal the
/// installer writes and what App.xaml.cs already parses OrdinalIgnoreCase.
/// </summary>
public static class StartupSelfHeal
{
    private const string TaskName = "ConnectLiveAgent";
    private const string WatchTaskName = "ConnectLiveWatch";
    private const string WatchExeName = "ConnectLiveWatch.exe";
    private const string ShortcutFileName = "ConnectLive.lnk";
    private const string BackgroundFlag = "/background";

    public static void EnsureAll()
    {
        try
        {
            var exePath = StartupRegistration.CurrentExePath();
            if (string.IsNullOrWhiteSpace(exePath))
            {
                Log.Warn("self-heal: cannot resolve current exe path");
                return;
            }

            if (!StartupRegistration.IsRunningFromInstallDir(exePath!, out var installDir))
            {
                Log.Info($"self-heal: dev/non-installed path — autostart triggers left untouched (exe='{exePath}')");
                return;
            }

            // 1. Run key (already idempotent + guarded internally).
            try { StartupRegistration.RegisterStartupWithWindows(); }
            catch (Exception ex) { Log.Warn($"self-heal[run-key]: {ex.Message}"); }

            // 2. Startup folder shortcut.
            try { EnsureStartupShortcut(exePath!, installDir!); }
            catch (Exception ex) { Log.Warn($"self-heal[shortcut]: {ex.Message}"); }

            // 3. Scheduled Task.
            try { EnsureScheduledTask(exePath!); }
            catch (Exception ex) { Log.Warn($"self-heal[task]: {ex.Message}"); }

            // 4. Watch scheduled task — 1-minute tick that beacons "stopped"
            //    to the server when ConnectLive.exe is not running, then
            //    relaunches it. This is what tells the admin panel a user
            //    killed the agent in Task Manager (the main process can't
            //    report its own TerminateProcess).
            try { EnsureWatchScheduledTask(installDir!); }
            catch (Exception ex) { Log.Warn($"self-heal[watch]: {ex.Message}"); }
        }
        catch (Exception ex)
        {
            Log.Warn($"self-heal: {ex.Message}");
        }
    }

    private static void EnsureStartupShortcut(string exePath, string installDir)
    {
        var startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        if (string.IsNullOrWhiteSpace(startupDir)) return;
        var lnkPath = Path.Combine(startupDir, ShortcutFileName);
        if (File.Exists(lnkPath)) return; // never overwrite an existing shortcut

        // Late-bound WScript.Shell — avoids an interop reference and works
        // on any WPF/.NET desktop install.
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType is null) { Log.Warn("self-heal[shortcut]: WScript.Shell unavailable"); return; }
        object? shell = Activator.CreateInstance(shellType);
        if (shell is null) { Log.Warn("self-heal[shortcut]: cannot instantiate WScript.Shell"); return; }
        try
        {
            var shortcut = shellType.InvokeMember("CreateShortcut",
                System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            if (shortcut is null) return;
            var sType = shortcut.GetType();
            void Set(string prop, object val) => sType.InvokeMember(prop,
                System.Reflection.BindingFlags.SetProperty, null, shortcut, new[] { val });
            Set("TargetPath", exePath);
            Set("Arguments", BackgroundFlag);
            Set("WorkingDirectory", installDir);
            Set("WindowStyle", 7);
            Set("Description", "ConnectLive Agent");
            sType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
            try { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut); } catch { }
            Log.Info($"self-heal: startup shortcut created at {lnkPath}");
        }
        finally
        {
            try { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); } catch { }
        }

    }

    private static void EnsureScheduledTask(string exePath)
    {
        if (RunSchTasks($"/Query /TN \"{TaskName}\"") == 0) return;

        var tr = $"\\\"{exePath}\\\" {BackgroundFlag}";
        var args = $"/Create /F /SC ONLOGON /TN \"{TaskName}\" /TR \"{tr}\" /RL LIMITED /DELAY 0000:10";
        var rc = RunSchTasks(args);
        if (rc == 0) Log.Info($"self-heal: scheduled task '{TaskName}' recreated");
        else         Log.Warn($"self-heal[task]: schtasks create exited {rc}");
    }

    private static void EnsureWatchScheduledTask(string installDir)
    {
        var watchPath = Path.Combine(installDir, WatchExeName);
        if (!File.Exists(watchPath))
        {
            // The watch companion ships alongside ConnectLive.exe. If it is
            // missing (pre-watch installer), leave the fleet alone rather
            // than register a task pointing at a non-existent path.
            Log.Info($"self-heal[watch]: {WatchExeName} not present — skipping");
            return;
        }

        if (RunSchTasks($"/Query /TN \"{WatchTaskName}\"") == 0) return;

        var tr = $"\\\"{watchPath}\\\"";
        // /SC MINUTE /MO 1 = every minute. /RL LIMITED = current user, no
        // elevation prompt. /F = overwrite if a stale entry exists.
        var args =
            $"/Create /F /SC MINUTE /MO 1 /TN \"{WatchTaskName}\" /TR \"{tr}\" /RL LIMITED";
        var rc = RunSchTasks(args);
        if (rc == 0) Log.Info($"self-heal: watch task '{WatchTaskName}' registered (1-minute tick)");
        else         Log.Warn($"self-heal[watch]: schtasks create exited {rc}");
    }

    private static int RunSchTasks(string arguments)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "schtasks.exe",
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var p = Process.Start(psi);
        if (p is null) return -1;
        p.WaitForExit(15000);
        return p.HasExited ? p.ExitCode : -1;
    }
}
