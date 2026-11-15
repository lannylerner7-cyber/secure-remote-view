using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>MSI's explicit uninstall intent, never an autorun or elevation mechanism.</summary>
internal static class InstallationLifecycle
{
    // Outside the MSI component's registry values: this receipt must survive an
    // uninstall/reinstall, including for users who were signed out at removal.
    private const string HistoryKey = @"Software\ConnectLive\RemovalHistory";

    internal static string RemovalKeyFor(string directory) => Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes(Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory)).ToUpperInvariant())));

    internal static string? CurrentRemovalGeneration()
    {
        using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var history = root.OpenSubKey(HistoryKey);
        var value = history?.GetValue(RemovalKeyFor(AppContext.BaseDirectory));
        if (value == null) return null;
        return value is string generation && Guid.TryParseExact(generation, "D", out _)
            ? generation : throw new InvalidDataException("Installation removal receipt is invalid.");
    }

    internal static bool GrantIsCurrent(LocalGrant grant, Func<string?>? readGeneration = null)
    {
        try { return grant.InstallationGeneration == (readGeneration ?? CurrentRemovalGeneration)(); }
        catch { return false; }
    }

    internal static void RecordMachineRemoval()
    {
        if (!UpdateEnvironment.IsElevated())
            throw new UnauthorizedAccessException("Machine-wide uninstall requires administrator approval.");
        using var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var history = root.CreateSubKey(HistoryKey, writable: true);
        history.SetValue(RemovalKeyFor(AppContext.BaseDirectory), Guid.NewGuid().ToString("D"), RegistryValueKind.String);
        history.Flush();
        using var key = root.CreateSubKey(@"Software\ConnectLive", writable: true);
        key.SetValue("UninstallRequested", AppContext.BaseDirectory, RegistryValueKind.String);
        key.Flush();
    }

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
