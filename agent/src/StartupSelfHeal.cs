using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Xml.Linq;

namespace ConnectLive.Agent;

/// <summary>One visible, locally authorized startup entry and an interactive limited-user recovery task.</summary>
public static class StartupSelfHeal
{
    private static string WatchTaskName => "ConnectLiveWatch-" + WindowsIdentity.GetCurrent().User!.Value;

    public static void EnsureAll()
    {
        var exe = StartupRegistration.CurrentExePath();
        if (exe == null || !StartupRegistration.IsRunningFromInstallDir(exe, out var directory)) return;
        if (!StartupConsent.IsAllowed()) { RemoveAll(); return; }
        StartupRegistration.RegisterStartupWithWindows();
        RemoveLegacyUserTriggers();
        var watch = Path.Combine(directory!, "ConnectLiveWatch.exe");
        if (!File.Exists(watch)) { Log.Warn("startup: Watch package missing; crash recovery is not registered"); return; }
        XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
        XElement E(string name, params object[] children) => new(ns + name, children);
        var task = E("Task",
            new XAttribute("version", "1.2"),
            E("RegistrationInfo", E("Description", "ConnectLive authorized Watch companion: recovery and web relaunch; disable in Agent settings.")),
            E("Triggers", E("TimeTrigger",
                E("Repetition", E("Interval", "PT1M"), E("StopAtDurationEnd", "false")),
                E("StartBoundary", DateTime.Now.AddMinutes(1).ToString("s")), E("Enabled", "true"))),
            E("Principals", E("Principal", new XAttribute("id", "CurrentUser"),
                E("UserId", WindowsIdentity.GetCurrent().User!.Value),
                E("LogonType", "InteractiveToken"), E("RunLevel", "LeastPrivilege"))),
            E("Settings", E("MultipleInstancesPolicy", "IgnoreNew"),
                E("DisallowStartIfOnBatteries", "false"), E("StopIfGoingOnBatteries", "false"),
                E("StartWhenAvailable", "true"), E("Hidden", "false"),
                E("WakeToRun", "false"), E("ExecutionTimeLimit", "PT0S")),
            E("Actions", new XAttribute("Context", "CurrentUser"),
                E("Exec", E("Command", watch), E("WorkingDirectory", directory!))));
        var xml = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ConnectLive", "watch-task.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(xml)!);
        File.WriteAllText(xml, "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n" + task, Encoding.Unicode);
        if (!RunSchTasks("/Create", "/F", "/TN", WatchTaskName, "/XML", xml))
            Log.Warn("startup: Windows declined the limited-user recovery task; no elevated fallback was attempted");
        // Start now; the task is the documented fallback if Watch itself exits.
        if (StartupConsent.IsAllowed())
        {
            try { Process.Start(new ProcessStartInfo(watch) { UseShellExecute = false, WorkingDirectory = directory! }); }
            catch { Log.Warn("startup: Watch launch failed; scheduled recovery remains available"); }
        }
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
