using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;

namespace ConnectLive.Agent;

internal sealed record ApprovedFolder(string Id, string Name, string Path);
internal sealed record SessionToolsConsent(int Version, string Origin, string DeviceId,
    string AuthorizationId, bool Microphone, ApprovedFolder[] Folders);

/// <summary>Separate local consent, not new keys in the exact-key pairing grant.</summary>
internal static class SessionToolsPolicy
{
    private static readonly string Store = Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData), "ConnectLive", "session-tools.dat");
    private static readonly object Gate = new();
    private static SessionToolsConsent? _consent;
    private static long _checked;
    private static DateTime _written;
    internal static SessionToolsConsent? Read(ApiClient api)
    {
        if (LocalAccessState.IsDisabled() || api.LocalAuthorization == null) return null;
        lock (Gate)
        {
            try
            {
                if (Environment.TickCount64 - _checked > 200)
                {
                    _checked = Environment.TickCount64;
                    var written = File.GetLastWriteTimeUtc(Store);
                    if (!File.Exists(Store)) _consent = null;
                    else if (_consent == null || written != _written)
                    {
                        byte[] plain = ProtectedData.Unprotect(File.ReadAllBytes(Store), null, DataProtectionScope.CurrentUser);
                        try { _consent = JsonSerializer.Deserialize<SessionToolsConsent>(plain); _written = written; }
                        finally { CryptographicOperations.ZeroMemory(plain); }
                    }
                }
                return _consent is { Version: 1, Folders.Length: <= 8 } &&
                    _consent.Origin == api.ApiBaseUrl && _consent.DeviceId == api.DeviceId &&
                    _consent.AuthorizationId == api.LocalAuthorization.Authorization.Id ? _consent : null;
            }
            catch { _consent = null; return null; }
        }
    }
    internal static void Save(ApiClient api, bool microphone, IEnumerable<ApprovedFolder> folders)
    {
        if (api.DeviceId == null || api.LocalAuthorization == null || LocalAccessState.IsDisabled())
            throw new InvalidOperationException("Pair the device first.");
        var roots = folders.Take(8).ToArray();
        foreach (var root in roots) RemoteFileAccess.ValidateRoot(root.Path);
        var consent = new SessionToolsConsent(1, api.ApiBaseUrl, api.DeviceId,
            api.LocalAuthorization.Authorization.Id, microphone, roots);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(consent);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Store)!);
            var encrypted = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
            File.WriteAllBytes(Store + ".tmp", encrypted);
            File.Move(Store + ".tmp", Store, true);
            lock (Gate) { _consent = null; _checked = 0; }
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    internal static void Forget()
    {
        lock (Gate) { _consent = null; _checked = 0; if (File.Exists(Store)) File.Delete(Store); }
    }
}
