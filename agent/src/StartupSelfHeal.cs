using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;

namespace ConnectLive.Agent;

/// <summary>One visible, locally authorized startup entry and an interactive limited-user recovery task.</summary>
public static class StartupSelfHeal
{
    private static string WatchTaskName => "ConnectLiveWatch-" + WindowsIdentity.GetCurrent().User!.Value;

    public static bool EnsureAll()
    {
        var exe = StartupRegistration.CurrentExePath();
        if (exe == null || !StartupRegistration.IsRunningFromInstallDir(exe, out var directory)) return false;
        if (!StartupConsent.IsAllowed()) { RemoveAll(); return false; }
        var runRegistered = StartupRegistration.RegisterStartupWithWindows();
        RemoveLegacyUserTriggers();
        var watch = Path.Combine(directory!, "ConnectLiveWatch.exe");
        if (!File.Exists(watch)) { Log.Warn("startup: Watch package missing; crash recovery is not registered"); return false; }
        var task = StartupTaskDefinition.Create(WindowsIdentity.GetCurrent().User!.Value,
            watch, directory!, DateTime.Now.AddMinutes(1));
        var xml = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ConnectLive", "watch-task.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(xml)!);
        File.WriteAllText(xml, "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n" + task, Encoding.Unicode);
        var taskRegistered = RunSchTasks("/Create", "/F", "/TN", WatchTaskName, "/XML", xml);
        if (!taskRegistered)
            Log.Warn("startup: Windows declined the limited-user recovery task; no elevated fallback was attempted");
        Log.Info($"startup: registration run={runRegistered} watch_task={taskRegistered}; starts after this user signs in, not before login");
        // Start now; the task is the documented fallback if Watch itself exits.
        if (StartupConsent.IsAllowed())
        {
            try { Process.Start(new ProcessStartInfo(watch) { UseShellExecute = false, WorkingDirectory = directory! }); }
            catch { Log.Warn("startup: Watch launch failed; scheduled recovery remains available"); }
        }
        return runRegistered && taskRegistered;
    }

    public static void RemoveAll()
    {
        StartupRegistration.Unregister();
        try { RunSchTasks("/Delete", "/F", "/TN", WatchTaskName); } catch { }
        RemoveLegacyUserTriggers();
    }

    private static void RemoveLegacyUserTriggers()
    {
        try
        {
            var shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "ConnectLive.lnk");
            if (File.Exists(shortcut)) File.Delete(shortcut);
        }
        catch { Log.Warn("startup: legacy shortcut needs IT cleanup"); }
        // Old installs used shared names. Deletion is attempted only with the
        // current user's rights; machine-owned legacy tasks require IT cleanup.
        RunSchTasks("/Delete", "/F", "/TN", "ConnectLiveAgent");
        RunSchTasks("/Delete", "/F", "/TN", "ConnectLiveWatch");
    }

    private static bool RunSchTasks(params string[] arguments)
    {
        try
        {
            var start = new ProcessStartInfo("schtasks.exe")
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
            };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var process = Process.Start(start);
            if (process == null) return false;
            // Drain both pipes before waiting: a full error pipe must not hang startup.
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(10_000)) { process.Kill(); return false; }
            return process.ExitCode == 0;
        }
        catch { return false; }
    }
}
