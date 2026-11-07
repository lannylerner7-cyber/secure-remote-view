using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace ConnectLive.Agent;

/// <summary>Local, explicitly chosen startup/recovery policy, bound to the recorded grant.</summary>
internal static class StartupConsent
{
    internal const string Notice =
        "Start ConnectLive with Windows, keep Watch available for crash recovery and authorized web relaunch, " +
        "and install signed updates while idle. Relaunch never overrides local withdrawal. " +
        "Run ConnectLive.exe /disable or uninstall ConnectLive to stop these functions. " +
        "This does not add remote permissions or administrator privileges.";
    private static string FileName => Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData), "ConnectLive", "startup-consent.dat");
    private sealed record Choice(int NoticeVersion, bool Enabled, string Origin, string DeviceId, string AuthorizationId);

    internal static bool IsAllowed()
    {
        if (LocalAccessState.IsDisabled() || SessionPairingRequirement.RequiredOnDisk ||
            InstallationLifecycle.RemovalRequested()) return false;
        try
        {
            var grant = GrantStore.Load();
            var choice = JsonSerializer.Deserialize<Choice>(ProtectedData.Unprotect(
                File.ReadAllBytes(FileName), null, DataProtectionScope.CurrentUser));
            return grant != null && choice is { NoticeVersion: 1, Enabled: true } &&
                choice.Origin == grant.Origin && choice.DeviceId == grant.DeviceId &&
                choice.AuthorizationId == grant.Authorization.Id;
        }
        catch { return false; }
    }

    internal static void Save(LocalGrant grant, bool enabled)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FileName)!);
        var bytes = ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(
            new Choice(1, enabled, grant.Origin, grant.DeviceId, grant.Authorization.Id)),
            null, DataProtectionScope.CurrentUser);
        var temporary = FileName + ".tmp";
        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            output.Write(bytes);
            output.Flush(true);
        }
        File.Move(temporary, FileName, true);
    }

    internal static void Clear()
    {
        if (File.Exists(FileName)) File.Delete(FileName);
    }
}
