using System;
using System.Text.Json.Serialization;

namespace ConnectLive.Admin.Api;

public sealed class LoginResponse
{
    [JsonPropertyName("session")] public LoginSession? Session { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("attemptsLeft")] public int? AttemptsLeft { get; set; }
    [JsonPropertyName("lockedForSeconds")] public int? LockedForSeconds { get; set; }
}

public sealed class LoginSession
{
    [JsonPropertyName("access_token")] public string AccessToken { get; set; } = "";
    [JsonPropertyName("refresh_token")] public string RefreshToken { get; set; } = "";
}

public sealed class DeviceRow
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("device_id")] public string DeviceId { get; set; } = "";
    [JsonPropertyName("display_name")] public string? DisplayName { get; set; }
    [JsonPropertyName("hostname")] public string? Hostname { get; set; }
    [JsonPropertyName("os")] public string? Os { get; set; }
    [JsonPropertyName("last_seen_at")] public DateTimeOffset? LastSeenAt { get; set; }
    [JsonPropertyName("status")] public string? Status { get; set; }
    [JsonPropertyName("is_session_active")] public bool IsSessionActive { get; set; }
    [JsonPropertyName("metadata")] public System.Text.Json.JsonElement Metadata { get; set; }
}

public sealed class SessionRow
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("device_id")] public string DeviceId { get; set; } = "";
    [JsonPropertyName("state")] public string State { get; set; } = "";
    [JsonPropertyName("mode")] public string Mode { get; set; } = "view";
    [JsonPropertyName("created_at")] public DateTimeOffset? CreatedAt { get; set; }
}

public sealed class SessionSignal
{
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("from_side")] public string FromSide { get; set; } = "";
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("payload")] public object? Payload { get; set; }
    [JsonPropertyName("admin_client_id")] public string? AdminClientId { get; set; }
}
