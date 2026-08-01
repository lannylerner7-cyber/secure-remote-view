using System;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>
/// Self-persistence. The Agent writes its own HKCU Run key after a successful
/// enrollment instead of letting the installer do it — an elevated installer
/// runs under a different user hive on silent enterprise deployments and would
/// register the Agent for the wrong profile.
///
/// Idempotent: safe to call on every start.
///
/// Guard: the key is only written when the running exe lives in the INSTALLED
/// location (Inno's InstallLocation, or %ProgramFiles%\ConnectLive). A dev run
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

    /// <summary>Installed folder per Inno, falling back to %ProgramFiles%\ConnectLive.</summary>
    private static string? InstalledDirectory()
    {
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var key = hklm.OpenSubKey(UninstallKeyPath);
                var loc = key?.GetValue("InstallLocation") as string;
                if (!string.IsNullOrWhiteSpace(loc)) return loc.Trim().TrimEnd('\\');
            }
            catch { }
        }

        try
        {
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (!string.IsNullOrWhiteSpace(pf)) return Path.Combine(pf, "ConnectLive");
        }
        catch { }
        return null;
    }

    internal static bool IsRunningFromInstallDir(string exePath, out string? installDir)
    {
        installDir = InstalledDirectory();
        if (string.IsNullOrWhiteSpace(installDir)) return false;
        try
        {
            var exeDir = Path.GetFullPath(Path.GetDirectoryName(exePath) ?? "").TrimEnd('\\');
            var target = Path.GetFullPath(installDir).TrimEnd('\\');
            return string.Equals(exeDir, target, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }


    public static void RegisterStartupWithWindows()
    {
        try
        {
            var exePath = CurrentExePath();
            if (string.IsNullOrWhiteSpace(exePath)) return;

            if (!IsRunningFromInstallDir(exePath!, out var installDir))
            {
                Log.Info($"startup: dev/non-installed path — Run key left untouched " +
                         $"(exe='{exePath}', installed='{installDir ?? "<unknown>"}')");
                return;
            }

            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true)
                            ?? Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
            var desired = $"\"{exePath}\" {BackgroundFlag}";
            var existing = key?.GetValue(ValueName) as string;
            if (string.Equals(existing, desired, StringComparison.OrdinalIgnoreCase)) return;
            key?.SetValue(ValueName, desired);
            Log.Info("startup: HKCU Run key registered");
        }
        catch (Exception ex)
        {
            // Non-fatal — a locked-down hive must never stop the Agent.
            Debug.WriteLine($"[ConnectLive] Startup key write failed: {ex.Message}");
            Log.Warn($"startup key write failed: {ex.Message}");
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
