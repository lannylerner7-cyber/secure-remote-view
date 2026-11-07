using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Api;

public sealed class WindowsUnlockDevice
{
    [JsonPropertyName("deviceId")] public string DeviceId { get; set; } = "";
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("authorizationId")] public string? AuthorizationId { get; set; }
    [JsonPropertyName("keyId")] public string? KeyId { get; set; }
    [JsonPropertyName("publicKey")] public string? PublicKey { get; set; }
    [JsonPropertyName("windowsAccount")] public string? WindowsAccount { get; set; }
    [JsonPropertyName("locked")] public bool? Locked { get; set; }
    [JsonPropertyName("helperReady")] public bool HelperReady { get; set; }
    [JsonPropertyName("hasPin")] public bool HasPin { get; set; }
    [JsonPropertyName("canManage")] public bool CanManage { get; set; }
}
public sealed class WindowsUnlockTicket
{
    [JsonPropertyName("requestId")] public string RequestId { get; set; } = "";
    [JsonPropertyName("expiresAt")] public DateTimeOffset ExpiresAt { get; set; }
}
public sealed partial class ApiClient
{
    private async Task<T> WindowsUnlockRequestAsync<T>(string deviceId, HttpMethod method, object? body, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(AccessToken)) throw new InvalidOperationException("Sign in before using Windows unlock.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        using var request = new HttpRequestMessage(method,
            $"{_config.BaseUrl}/api/public/admin/device/{Uri.EscapeDataString(deviceId)}/unlock");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AccessToken);
        request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
        if (body != null) request.Content = JsonContent.Create(body);
        // No retry middleware: an uncertain credential-use request is not replayed.
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException("Windows unlock was not authorized or is unavailable. Check local setup, server migration and current access. No automatic retry was made.");
        if (response.Content.Headers.ContentLength is > 8192) throw new InvalidOperationException("Invalid Windows unlock response.");
        using var input = await response.Content.ReadAsStreamAsync(deadline.Token).ConfigureAwait(false);
        var bytes = new byte[8193]; int count = 0;
        while (count < bytes.Length)
        {
            int read = await input.ReadAsync(bytes.AsMemory(count), deadline.Token).ConfigureAwait(false);
            if (read == 0) break;
            count += read;
        }
        if (count > 8192) throw new InvalidOperationException("Invalid Windows unlock response.");
        return JsonSerializer.Deserialize<T>(bytes.AsSpan(0, count)) ?? throw new InvalidOperationException("Invalid Windows unlock response.");
    }
    public Task<WindowsUnlockDevice> GetWindowsUnlockAsync(string deviceId, CancellationToken ct) =>
        WindowsUnlockRequestAsync<WindowsUnlockDevice>(deviceId, HttpMethod.Get, null, ct);
    public Task<WindowsUnlockDevice> RemoveWindowsPinAsync(string deviceId, bool revoke, CancellationToken ct) =>
        WindowsUnlockRequestAsync<WindowsUnlockDevice>(deviceId, HttpMethod.Delete, new { action = revoke ? "revoke" : "forget" }, ct);
    public Task<WindowsUnlockTicket> BeginWindowsUnlockAsync(string deviceId, string sessionId, string peerId, CancellationToken ct) =>
        WindowsUnlockRequestAsync<WindowsUnlockTicket>(deviceId, HttpMethod.Post, new { action = "begin", sessionId, peerId }, ct);
    public async Task<WindowsUnlockDevice> SaveWindowsPinAsync(WindowsUnlockDevice device, string pin, CancellationToken ct)
    {
        if (!device.Enabled || !device.CanManage || device.KeyId == null || device.PublicKey == null ||
            device.AuthorizationId == null || pin.Length is < 4 or > 127)
            throw new InvalidOperationException("Confirm the enrolled device and enter a 4–127 character Windows Hello PIN.");
        foreach (char ch in pin) if (ch is < ' ' or > '~') throw new InvalidOperationException("Use printable ASCII characters; no trimming or conversion is performed.");
        using var rsa = RSA.Create();
        rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(device.PublicKey), out _);
        if (rsa.KeySize != 3072) throw new InvalidOperationException("Unsupported Agent encryption key.");
        var plain = Encoding.UTF8.GetBytes(pin);
        var key = RandomNumberGenerator.GetBytes(32);
        try
        {
            var iv = RandomNumberGenerator.GetBytes(12);
            var cipher = new byte[plain.Length]; var tag = new byte[16];
            var aad = Encoding.UTF8.GetBytes($"ConnectLive.WindowsHelloPin.v1\n{device.DeviceId.ToLowerInvariant()}\n{device.AuthorizationId.ToLowerInvariant()}\n{device.KeyId.ToLowerInvariant()}");
            using (var aes = new AesGcm(key, 16)) aes.Encrypt(iv, plain, cipher, tag, aad);
            var combined = new byte[cipher.Length + tag.Length];
            cipher.CopyTo(combined, 0); tag.CopyTo(combined, cipher.Length);
            var envelope = new {
                version = 1, algorithm = "RSA-OAEP-256+A256GCM", keyId = device.KeyId,
                wrappedKey = Convert.ToBase64String(rsa.Encrypt(key, RSAEncryptionPadding.OaepSHA256)),
                iv = Convert.ToBase64String(iv), ciphertext = Convert.ToBase64String(combined),
            };
            return await WindowsUnlockRequestAsync<WindowsUnlockDevice>(device.DeviceId, HttpMethod.Put,
                new { action = "save", authorizationId = device.AuthorizationId, sealedPin = envelope }, ct).ConfigureAwait(false);
        }
        finally { CryptographicOperations.ZeroMemory(plain); CryptographicOperations.ZeroMemory(key); }
    }
}
