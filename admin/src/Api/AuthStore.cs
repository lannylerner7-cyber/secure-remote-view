using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ConnectLive.Admin.Api;

/// <summary>
/// Stores the Supabase access + refresh tokens under %AppData%\ConnectLiveAdmin\
/// using DPAPI (CurrentUser scope). Never written in plaintext.
/// </summary>
public sealed class AuthStore
{
    public sealed class Session
    {
        [JsonPropertyName("access_token")] public string AccessToken { get; set; } = "";
        [JsonPropertyName("refresh_token")] public string RefreshToken { get; set; } = "";
        [JsonPropertyName("expires_at")] public long ExpiresAt { get; set; }
        [JsonPropertyName("user_id")] public string UserId { get; set; } = "";
    }

    private static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ConnectLiveAdmin");
    private static readonly string Path_ = Path.Combine(Dir, "session.dat");

    public Session? Current { get; private set; }

    public AuthStore() => Load();

    public bool HasValidSession()
        => Current != null
           && !string.IsNullOrEmpty(Current.AccessToken)
           && Current.ExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30;

    public void Save(Session s)
    {
        Directory.CreateDirectory(Dir);
        var json = JsonSerializer.SerializeToUtf8Bytes(s);
        var encrypted = ProtectedData.Protect(json, null, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(Path_, encrypted);
        Current = s;
    }

    public void Clear()
    {
        Current = null;
        try { if (File.Exists(Path_)) File.Delete(Path_); } catch { }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(Path_)) return;
            var encrypted = File.ReadAllBytes(Path_);
            var json = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
            Current = JsonSerializer.Deserialize<Session>(json);
        }
        catch
        {
            Current = null;
        }
    }
}
