using System.Text.Json;

namespace ConnectLive.Native;

internal static class OfferGeneration
{
    public static string? Read(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty("offer_id", out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    public static bool Matches(string? expected, JsonElement payload) =>
        string.Equals(expected, Read(payload), System.StringComparison.Ordinal);
}
