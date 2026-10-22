using System;
using System.Net.Http;

namespace ConnectLive.Native;

// Shared by the two native clients; keep transport policy independent of WPF.
internal static class NativeGatewayPolicy
{
    internal static readonly TimeSpan IceBudget = TimeSpan.FromSeconds(12);

    internal static string ValidateOrigin(string? value, string setting)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            !Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps || string.IsNullOrEmpty(uri.Host) ||
            !string.IsNullOrEmpty(uri.UserInfo) || value.Contains('?') || value.Contains('#') ||
            uri.AbsolutePath != "/")
            throw new InvalidOperationException(
                $"{setting} must be an explicit HTTPS origin (https://host[:port]), without credentials, path, query or fragment. Update your client configuration.");
        return uri.GetLeftPart(UriPartial.Authority);
    }

    // Reject all redirects, including same-origin ones: a deployment must
    // configure the final origin rather than forward device/bearer tokens.
    internal static HttpClientHandler CreateHandler() => new() { AllowAutoRedirect = false };

    internal static string IcePath(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
            throw new ArgumentException("An authorized session ID is required for ICE.", nameof(sessionId));
        return "/api/public/agent/ice?sessionId=" + Uri.EscapeDataString(sessionId);
    }
}
