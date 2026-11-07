using System.Text.Json;

namespace ConnectLive.Agent;

/// <summary>Only an authenticated, explicitly ended matching session asks for a new code.</summary>
internal static class SessionCompletion
{
    internal static bool RequiresPairing(string body, string? sessionId, string? authorizationId)
    {
        if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(authorizationId)) return false;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("session_status", out var status) ||
                status.ValueKind != JsonValueKind.Object) return false;
            return status.GetProperty("id").GetString() == sessionId &&
                status.GetProperty("authorization_id").GetString() == authorizationId &&
                status.GetProperty("state").GetString() == "ended";
        }
        catch { return false; }
    }
}
