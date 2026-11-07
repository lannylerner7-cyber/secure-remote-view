using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ConnectLive.Unlock;

namespace ConnectLive.Agent;

internal sealed record UnlockIdentity(string Origin, string DeviceId, string AuthorizationId,
    string KeyId, string PublicKey, string PrivateKey, string WindowsAccount, bool Registered)
{
    public override string ToString() => "ConnectLive unlock identity (redacted)";
}
internal static class UnlockEnrollment
{
    private static readonly object Gate = new();
    private static readonly string Store = Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData), "ConnectLive", "unlock.dat");
    internal static UnlockIdentity? Current { get; private set; }
    internal static bool Ready { get; private set; }
    internal static bool HasLocalOptIn => Current?.Registered == true && File.Exists(Store) && !LocalAccessState.IsDisabled();
    private static long _seen;
    internal static bool Fresh => Ready && Environment.TickCount64 - System.Threading.Interlocked.Read(ref _seen) < 7000;
    internal static bool Matches(ApiClient api, UnlockIdentity identity) =>
        !LocalAccessState.IsDisabled() && identity.Origin == api.ApiBaseUrl && identity.DeviceId == api.DeviceId &&
        api.LocalAuthorization?.Authorization.Id == identity.AuthorizationId &&
        api.LocalAuthorization.Authorization.Mode == "unattended" &&
        api.LocalAuthorization.Authorization.Capabilities is { View: true, Control: true };
    private static UnlockIdentity? Load()
    {
        try
        {
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(Store), null, DataProtectionScope.CurrentUser);
            try { return JsonSerializer.Deserialize<UnlockIdentity>(plain); }
            finally { CryptographicOperations.ZeroMemory(plain); }
        }
        catch { return null; }
    }
    private static void Save(UnlockIdentity value)
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            var protectedBytes = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);
            Directory.CreateDirectory(Path.GetDirectoryName(Store)!);
            var temp = Store + ".tmp";
            File.WriteAllBytes(temp, protectedBytes);
            File.Move(temp, Store, true);
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
        Current = value;
    }
    internal static void Forget()
    {
        lock (Gate)
        {
            Ready = false; Current = null;
            if (File.Exists(Store)) File.Delete(Store);
        }
    }
    internal static object BrokerRequest(string action, UnlockIdentity value) => new {
        action, deviceId = value.DeviceId, authorizationId = value.AuthorizationId, origin = value.Origin,
    };
    internal static async Task<JsonDocument> BrokerAsync(string action, UnlockIdentity identity, CancellationToken ct)
    {
        using var pipe = await UnlockPipe.ConnectAsync(UnlockPipe.BrokerName, ct);
        await UnlockPipe.WriteAsync(pipe, BrokerRequest(action, identity), ct);
        return await UnlockPipe.ReadAsync(pipe, ct);
    }
    internal static async Task MonitorAsync(ApiClient api, CancellationToken ct)
    {
        Current = Load();
        while (!ct.IsCancellationRequested)
        {
            var persisted = Load();
            if (persisted != Current) { Current = persisted; Ready = false; }
            var local = Current;
            if (local == null) Ready = false;
            if (local?.Registered == true)
            {
                try
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    deadline.CancelAfter(TimeSpan.FromSeconds(3));
                    using var result = await api.UnlockRequestAsync(new { action = "status", keyId = local.KeyId }, deadline.Token);
                    var status = result.RootElement;
                    if (status.TryGetProperty("revoked", out var revoked) && revoked.ValueKind == JsonValueKind.True &&
                        status.GetProperty("keyId").GetString() == local.KeyId)
                    {
                        Forget();
                        // A deletion receipt is acknowledged only after local key deletion.
                        using var cleared = await api.UnlockRequestAsync(new { action = "cleared", keyId = local.KeyId }, deadline.Token);
                    }
                    else if (Matches(api, local) && status.GetProperty("keyId").GetString() == local.KeyId &&
                        status.GetProperty("authorizationId").GetString() == local.AuthorizationId &&
                        status.GetProperty("enabled").ValueKind == JsonValueKind.True)
                    {
                        using var broker = await BrokerAsync("status", local, deadline.Token);
                        bool ready = broker.RootElement.TryGetProperty("ready", out var r) && r.ValueKind == JsonValueKind.True;
                        using var report = await api.UnlockRequestAsync(new {
                            action = "report", keyId = local.KeyId, locked = WindowsSession.Locked(WindowsSession.CurrentId), helperReady = ready,
                        }, deadline.Token);
                        if (ready && Matches(api, local) && ReferenceEquals(Current, local))
                        {
                            System.Threading.Interlocked.Exchange(ref _seen, Environment.TickCount64);
                            Ready = true;
                        }
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch { Ready = false; /* Unknown authority never erases pairing or a key. */ }
            }
            try { await Task.Delay(3000, ct); } catch (OperationCanceledException) { break; }
        }
        Ready = false;
    }
    internal static byte[] OpenPin(JsonElement envelope, UnlockIdentity local)
    {
        if (envelope.GetProperty("version").GetInt32() != 1 ||
            envelope.GetProperty("algorithm").GetString() != "RSA-OAEP-256+A256GCM" ||
            envelope.GetProperty("keyId").GetString() != local.KeyId) throw new InvalidOperationException("unlock_key_changed");
        byte[] pkcs8 = Convert.FromBase64String(local.PrivateKey);
        byte[]? key = null;
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportPkcs8PrivateKey(pkcs8, out _);
            key = rsa.Decrypt(envelope.GetProperty("wrappedKey").GetBytesFromBase64(), RSAEncryptionPadding.OaepSHA256);
            byte[] cipher = envelope.GetProperty("ciphertext").GetBytesFromBase64();
            byte[] iv = envelope.GetProperty("iv").GetBytesFromBase64();
            if (key.Length != 32 || iv.Length != 12 || cipher.Length is < 20 or > 143)
                throw new InvalidOperationException("unlock_pin_invalid");
            var plain = new byte[cipher.Length - 16];
            using var aes = new AesGcm(key, 16);
            var context = Encoding.UTF8.GetBytes($"ConnectLive.WindowsHelloPin.v1\n{local.DeviceId.ToLowerInvariant()}\n{local.AuthorizationId.ToLowerInvariant()}\n{local.KeyId.ToLowerInvariant()}");
            try { aes.Decrypt(iv, cipher.AsSpan(0, plain.Length), cipher.AsSpan(plain.Length), plain, context); }
            catch { CryptographicOperations.ZeroMemory(plain); throw; }
            return plain;
        }
        finally { CryptographicOperations.ZeroMemory(pkcs8); if (key != null) CryptographicOperations.ZeroMemory(key); }
    }

    internal static async Task<bool> HandleSetupAsync(string[] args)
    {
        bool setup = Array.Exists(args, a => a == "--unlock-setup");
        bool enable = Array.Exists(args, a => a == "--unlock-enable");
        bool disable = Array.Exists(args, a => a == "--unlock-disable");
        if (!setup && !enable && !disable) return false;
        var api = new ApiClient();
        api.LocalAuthorization = GrantStore.Load();
        Current = Load();
        if (disable)
        {
            var old = Current;
            Forget(); // Local withdrawal always wins, even while offline.
            if (old != null)
            {
                try
                {
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    using var result = await api.UnlockRequestAsync(new { action = "revoke", keyId = old.KeyId }, deadline.Token);
                }
                catch { Log.Warn("Windows unlock disabled locally; server revocation is pending. Revoke unlock in Admin too."); }
            }
            Log.Info("Windows unlock disabled locally. The PIN was not read or logged.");
            return true;
        }
        if (api.DeviceId == null || api.LocalAuthorization == null || LocalAccessState.IsDisabled() ||
            api.LocalAuthorization.Authorization.Mode != "unattended" ||
            api.LocalAuthorization.Authorization.Capabilities is not { View: true, Control: true })
            throw new InvalidOperationException("Pair this Windows user with disclosed unattended view/control before enabling Windows unlock.");
        string executable = UnlockPipe.ProtectedPath("ConnectLive.exe");
        if (!string.Equals(Environment.ProcessPath, executable, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Windows unlock requires the manually installed Agent in Program Files\\ConnectLive, not dotnet run or a Downloads executable.");
        var binding = new {
            DeviceId = api.DeviceId, AuthorizationId = api.LocalAuthorization.Authorization.Id,
            Origin = api.ApiBaseUrl, UserSid = WindowsIdentity.GetCurrent().User!.Value,
            AgentPath = executable, AgentSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(executable))),
        };
        if (setup)
        {
            string path = Path.Combine(Path.GetDirectoryName(Store)!, "unlock-setup.json");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(binding));
            Log.Info("Windows unlock setup binding exported locally (no PIN, token or private key).");
            System.Windows.MessageBox.Show("Setup details were saved to:\n" + path +
                "\n\nHave your local administrator review Install-ConnectLiveUnlock.ps1, approve the service, then run ConnectLive.exe --unlock-enable as this Windows user.",
                "Windows unlock — local setup");
            return true;
        }
        if (System.Windows.MessageBox.Show(
            "Enable remote Windows unlocking for this paired device?\n\n" +
            "Authorized operators can view this user's Windows sign-in screen and use a Windows Hello PIN they explicitly save. " +
            "This reduces the protection of a device-only PIN. ConnectLive never extracts Windows Hello keys, biometrics or PINs.\n\n" +
            "Enabling again replaces the encryption key and removes any previously saved PIN; save it again in Admin.\n\n" +
            "This is separate from screen control and the privacy curtain. Use --unlock-disable or revoke it in Admin to stop it.",
            "Allow Windows unlock", System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Warning) != System.Windows.MessageBoxResult.Yes)
            return true;
        var candidate = Current;
        if (candidate == null || candidate.Registered || !Matches(api, candidate))
        {
            using var rsa = RSA.Create(3072);
            byte[] privateKey = rsa.ExportPkcs8PrivateKey();
            try
            {
                candidate = new UnlockIdentity(api.ApiBaseUrl, api.DeviceId, api.LocalAuthorization.Authorization.Id,
                    Guid.NewGuid().ToString(), Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo()),
                    Convert.ToBase64String(privateKey), WindowsIdentity.GetCurrent().Name, false);
                Save(candidate); // Persist pending identity before uncertain network delivery.
            }
            finally { CryptographicOperations.ZeroMemory(privateKey); }
        }
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var service = await BrokerAsync("status", candidate, timeout.Token);
        if (!service.RootElement.TryGetProperty("ready", out var ready) || ready.ValueKind != JsonValueKind.True)
            throw new InvalidOperationException("The approved unlock service is unavailable or its Agent/binding changed. Repeat local setup.");
        using var registered = await api.UnlockRequestAsync(new {
            action = "enable", version = 1, authorizationId = candidate.AuthorizationId, keyId = candidate.KeyId,
            publicKey = candidate.PublicKey, windowsAccount = candidate.WindowsAccount, consentAccepted = true,
        }, timeout.Token);
        if (registered.RootElement.GetProperty("keyId").GetString() != candidate.KeyId ||
            registered.RootElement.GetProperty("enabled").ValueKind != JsonValueKind.True)
            throw new InvalidOperationException("Windows unlock setup was not confirmed.");
        Save(candidate with { Registered = true });
        Log.Info("Windows unlock permission recorded. Save the PIN explicitly in Admin; no PIN was extracted.");
        return true;
    }
}
