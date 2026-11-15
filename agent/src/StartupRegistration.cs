using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>
/// Opted-in startup. The Agent writes its own HKCU Run key after explicit
/// local startup approval instead of letting the installer do it — an elevated installer
/// runs under a different user hive on silent enterprise deployments and would
/// register the Agent for the wrong profile.
///
/// Idempotent: safe to call on every start.
///
/// Guard: the key is only written when the running exe lives in the INSTALLED
/// location (registered MSI/Inno path or a supported default). A dev run
/// out of dist\ must never clobber the installed machine's autostart entry.
/// </summary>
public static class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "ConnectLive";

    // Inno AppId {{B4E9A1C2-7F3D-4A6E-9C2B-CONNECTLIVE500}} → uninstall key + "_is1".
    private const string UninstallKeyPath =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{B4E9A1C2-7F3D-4A6E-9C2B-CONNECTLIVE500}_is1";

    // Must match App.xaml.cs arg parsing (OrdinalIgnoreCase on "/BACKGROUND")
    // and the installer's post-install launch parameters.
    private const string BackgroundFlag = "/background";

    public static string? CurrentExePath()
    {
        try { return Process.GetCurrentProcess().MainModule?.FileName; }
        catch { return null; }
    }

    /// <summary>Registered install locations, not the directory of an arbitrary downloaded copy.</summary>
    private static IEnumerable<string> InstalledDirectories()
    {
        var directories = new List<string>();
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
            {
                try
                {
                    using var root = RegistryKey.OpenBaseKey(hive, view);
                    using var inno = root.OpenSubKey(UninstallKeyPath);
                    if (inno?.GetValue("InstallLocation") is string location && !string.IsNullOrWhiteSpace(location))
                        directories.Add(location);
                    // MSI supports INSTALLDIR overrides. Do not silently fall back
                    // to Program Files when that machine's actual path is different.
                    if (hive == RegistryHive.LocalMachine)
                    {
                        using var msi = root.OpenSubKey(@"Software\ConnectLive");
                        if (msi?.GetValue("Installed") is int installed && installed == 1 &&
                            msi.GetValue("InstallPath") is string path && !string.IsNullOrWhiteSpace(path))
                            directories.Add(path);
                    }
                }
                catch { }
            }
        }

        try
        {
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (!string.IsNullOrWhiteSpace(pf)) directories.Add(Path.Combine(pf, "ConnectLive"));
            directories.Add(UpdateEnvironment.UserInstall);
        }
        catch { }
        return directories;
    }

    internal static bool IsRunningFromInstallDir(string exePath, out string? installDir)
    {
        installDir = FindMatchingInstallDirectory(exePath, InstalledDirectories());
        return installDir != null;
    }

    internal static string? FindMatchingInstallDirectory(string exePath, IEnumerable<string> directories)
    {
        try
        {
            if (!Path.IsPathFullyQualified(exePath) ||
                !string.Equals(Path.GetFileName(exePath), "ConnectLive.exe", StringComparison.OrdinalIgnoreCase))
                return null;
            var exeDir = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetDirectoryName(exePath)!));
            foreach (var directory in directories)
            {
                if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory)) continue;
                var target = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
                if (string.Equals(exeDir, target, StringComparison.OrdinalIgnoreCase)) return target;
            }
        }
        catch { }
        return null;
    }


    public static bool RegisterStartupWithWindows()
    {
        if (!StartupConsent.IsAllowed()) { Unregister(); return false; }
        try
        {
            var exePath = CurrentExePath();
            if (string.IsNullOrWhiteSpace(exePath)) return false;

            if (!IsRunningFromInstallDir(exePath!, out var installDir))
            {
                Log.Info($"startup: dev/non-installed path — Run key left untouched " +
                         $"(exe='{exePath}', installed='{installDir ?? "<unknown>"}')");
                return false;
            }

            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true)
                            ?? Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
            var desired = $"\"{exePath}\" {BackgroundFlag}";
            var existing = key?.GetValue(ValueName) as string;
            if (string.Equals(existing, desired, StringComparison.OrdinalIgnoreCase)) return true;
            key?.SetValue(ValueName, desired);
            if (!string.Equals(key?.GetValue(ValueName) as string, desired, StringComparison.OrdinalIgnoreCase))
                return false;
            Log.Info("startup: HKCU Run key registered");
            return true;
        }
        catch (Exception ex)
        {
            // Non-fatal — a locked-down hive must never stop the Agent.
            Debug.WriteLine($"[ConnectLive] Startup key write failed: {ex.Message}");
            Log.Warn($"startup key write failed: {ex.Message}");
            return false;
        }
    }

    /// <summary>Removes the Run key (uninstall / "quit and don't start with Windows").</summary>
    public static void Unregister()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            key?.DeleteValue(ValueName, throwOnMissingValue: false);
            Log.Info("startup: HKCU Run key removed");
        }
        catch (Exception ex) { Log.Warn($"startup key removal failed: {ex.Message}"); }
    }
}
