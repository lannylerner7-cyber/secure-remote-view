using System;
using System.Xml.Linq;

namespace ConnectLive.Agent;

/// <summary>Visible, per-user logon/recovery task. Never a boot/SYSTEM capture service.</summary>
internal static class StartupTaskDefinition
{
    internal static XElement Create(string sid, string watch, string directory, DateTime firstRetry)
    {
        XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
        XElement E(string name, params object[] children) => new(ns + name, children);
        return E("Task",
            new XAttribute("version", "1.2"),
            E("RegistrationInfo", E("Description",
                "ConnectLive locally approved recovery. Run ConnectLive.exe /disable or uninstall to withdraw access.")),
            E("Triggers",
                E("LogonTrigger", E("Enabled", "true"), E("UserId", sid)),
                E("TimeTrigger",
                    E("Repetition", E("Interval", "PT1M"), E("StopAtDurationEnd", "false")),
                    E("StartBoundary", firstRetry.ToString("s")), E("Enabled", "true"))),
            E("Principals", E("Principal", new XAttribute("id", "CurrentUser"),
                E("UserId", sid), E("LogonType", "InteractiveToken"), E("RunLevel", "LeastPrivilege"))),
            E("Settings", E("MultipleInstancesPolicy", "IgnoreNew"),
                E("DisallowStartIfOnBatteries", "false"), E("StopIfGoingOnBatteries", "false"),
                E("StartWhenAvailable", "true"), E("Hidden", "false"),
                E("WakeToRun", "false"), E("ExecutionTimeLimit", "PT0S")),
            E("Actions", new XAttribute("Context", "CurrentUser"),
                E("Exec", E("Command", watch), E("WorkingDirectory", directory))));
    }
}
