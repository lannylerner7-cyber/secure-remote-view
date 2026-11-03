using System;
using System.Globalization;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

internal sealed record PairingOffer(string Id, string DisclosureId, string Organization,
    DateTimeOffset ExpiresAt, string Mode, GrantScopes Capabilities);

internal sealed class PairingAttempt
{
    internal string Code { get; }
    internal PairingOffer Offer { get; }
    internal string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    internal string RequestId { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    internal PairingAttempt(string code, PairingOffer offer) { Code = code; Offer = offer; }
    public override string ToString() => "ConnectLive pairing attempt (redacted)";
}

public sealed partial class ApiClient
{
    internal async Task<PairingOffer> InspectPairingAsync(string code, CancellationToken ct)
    {
        using var response = await _http.PostAsJsonAsync("/api/public/agent/pairing",
            new { action = "inspect", code }, ct);
        using var document = await ReadPairingResponseAsync(response, ct);
        var root = document.RootElement;
        var grant = root.GetProperty("grant");
        var capabilities = grant.GetProperty("capabilities");
        var scopes = new GrantScopes(capabilities.GetProperty("view").GetBoolean(),
            capabilities.GetProperty("control").GetBoolean(), capabilities.GetProperty("clipboard").GetBoolean(),
            capabilities.GetProperty("files").GetBoolean(), capabilities.GetProperty("recording").GetBoolean());
        var id = root.GetProperty("id").GetString() ?? "";
        var disclosure = root.GetProperty("disclosureId").GetString() ?? "";
        var organization = root.GetProperty("organization").GetString() ?? "";
        var mode = grant.GetProperty("mode").GetString() ?? "";
        if (!Guid.TryParse(id, out _) || !Guid.TryParse(disclosure, out _) ||
            string.IsNullOrWhiteSpace(organization) || organization.Length > 120 ||
            grant.GetProperty("noticeVersion").GetInt32() != 1 || !scopes.View ||
            mode is not ("attended" or "unattended") ||
            !DateTimeOffset.TryParse(root.GetProperty("expiresAt").GetString(), CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var expires) || expires <= DateTimeOffset.UtcNow)
            throw new InvalidOperationException("The pairing disclosure is invalid or expired.");
        return new(id, disclosure, organization, expires, mode, scopes);
    }

    internal async Task CompletePairingAsync(PairingAttempt attempt, CancellationToken ct)
    {
        var tokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(attempt.Token))).ToLowerInvariant();
        using var response = await _http.PostAsJsonAsync("/api/public/agent/pairing", new
        {
            action = "redeem", code = attempt.Code, accepted = true, noticeVersion = 1,
            disclosureId = attempt.Offer.DisclosureId, requestId = attempt.RequestId, tokenHash,
            hostname = Environment.MachineName, os = Environment.OSVersion.VersionString,
            agentVersion = typeof(ApiClient).Assembly.GetName().Version?.ToString() ?? "1.0.0",
        }, ct);
        using var document = await ReadPairingResponseAsync(response, ct);
        var root = document.RootElement;
        var deviceId = root.GetProperty("deviceId").GetString();
        var grant = root.TryGetProperty("authorization", out var value) ? AuthorizationGrant.Parse(value) : null;
        if (!Guid.TryParse(deviceId, out _) || grant == null || grant.Mode != attempt.Offer.Mode ||
            grant.Capabilities != attempt.Offer.Capabilities)
            throw new InvalidOperationException("Pairing did not match the permissions you reviewed. Remote access remains disabled.");
        ct.ThrowIfCancellationRequested();
        var local = new LocalGrant(LocalGrant.OriginOf(ApiBaseUrl), deviceId!, grant);
        // No capture starts until both the device credential and matching local
        // disclosure are durably saved. A failed save remains an explicit error.
        SaveDeviceCreds(new EnrollResponse(deviceId!, attempt.Token));
        GrantStore.Save(local);
        DeviceId = deviceId;
        DeviceToken = attempt.Token;
        LocalAuthorization = local;
        Interlocked.Increment(ref _tokenGeneration);
    }

    private static async Task<JsonDocument> ReadPairingResponseAsync(
        System.Net.Http.HttpResponseMessage response, CancellationToken ct)
    {
        var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        if (response.IsSuccessStatusCode) return document;
        var code = document.RootElement.TryGetProperty("error", out var value) ? value.GetString() : null;
        document.Dispose();
        throw new InvalidOperationException(code switch
        {
            "rate_limited" => "Too many pairing attempts. Wait a minute before retrying.",
            "pairing_seats_full" => "This organization's license has no free device seats.",
            _ => "Pairing is unavailable, used, revoked or expired. Ask your administrator for a current code.",
        });
    }
}
