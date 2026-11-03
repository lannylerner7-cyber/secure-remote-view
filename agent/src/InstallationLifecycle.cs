using System;
using System.IO;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>MSI's explicit uninstall intent, never an autorun or elevation mechanism.</summary>
internal static class InstallationLifecycle
{
    internal static bool RemovalRequested()
    {
        // The machine-wide MSI marker must not disable a separate source/test
        // copy or a per-user installation.
        try
        {
            using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            using var key = root.OpenSubKey(@"Software\ConnectLive");
            var directory = key?.GetValue("UninstallRequested") as string;
            if (string.IsNullOrWhiteSpace(directory) || directory == "none") return false;
            return string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory)),
                Path.TrimEndingDirectorySeparator(Path.GetFullPath(AppContext.BaseDirectory)),
                StringComparison.OrdinalIgnoreCase);
        }
        catch { return true; } // A machine-install state that cannot be read is not permission to relaunch.
    }
}
