using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace ConnectLive.Agent;

internal static class GrantStore
{
    private static string PathName => Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData), "ConnectLive", "authorization.dat");

    internal static LocalGrant? Load()
    {
        try
        {
            return JsonSerializer.Deserialize<LocalGrant>(ProtectedData.Unprotect(
                File.ReadAllBytes(PathName), null, DataProtectionScope.CurrentUser));
        }
        catch { return null; } // Missing, corrupt, other Windows user: dormant.
    }

    internal static void Save(LocalGrant grant)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(PathName)!);
        var temp = PathName + ".tmp";
        File.WriteAllBytes(temp, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(grant),
            null, DataProtectionScope.CurrentUser));
        File.Move(temp, PathName, true);
    }
}
