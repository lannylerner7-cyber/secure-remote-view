using System;
using System.Diagnostics;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>
/// Self-persistence. The Agent writes its own HKCU Run key after a successful
/// enrollment instead of letting the installer do it — an elevated installer
/// runs under a different user hive on silent enterprise deployments and would
/// register the Agent for the wrong profile.
///
/// Idempotent: safe to call on every start.
/// </summary>
public static class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "ConnectLive";

    public static string? CurrentExePath()
    {
        try { return Process.GetCurrentProcess().MainModule?.FileName; }
        catch { return null; }
    }

    public static void RegisterStartupWithWindows()
    {
        try
        {
            var exePath = CurrentExePath();
            if (string.IsNullOrWhiteSpace(exePath)) return;

            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true)
                            ?? Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
            var desired = $"\"{exePath}\" /background";
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
