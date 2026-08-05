using System;
using System.Collections.Generic;
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

/// <summary>Step 9 — one row from public.session_files for the Files panel.</summary>
public sealed class SessionFile
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("size_bytes")] public long SizeBytes { get; set; }
    [JsonPropertyName("mime")] public string Mime { get; set; } = "application/octet-stream";
    [JsonPropertyName("sha256")] public string? Sha256 { get; set; }
    [JsonPropertyName("direction")] public string Direction { get; set; } = "from_agent";
    [JsonPropertyName("transport")] public string Transport { get; set; } = "datachannel";
    [JsonPropertyName("created_at")] public DateTimeOffset? CreatedAt { get; set; }
}

/// <summary>Step 9 — response from the native-admin files route.</summary>
public sealed class SessionFilesList
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("files")] public List<SessionFile> Files { get; set; } = new();
    [JsonPropertyName("bytesUsed")] public long BytesUsed { get; set; }
    [JsonPropertyName("hasPassword")] public bool HasPassword { get; set; }
}

public sealed class PrepareUploadResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("path")] public string Path { get; set; } = "";
    [JsonPropertyName("token")] public string Token { get; set; } = "";
    [JsonPropertyName("signedUrl")] public string SignedUrl { get; set; } = "";
}

public sealed class PackageFilesResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("count")] public int Count { get; set; }
    [JsonPropertyName("url")] public string Url { get; set; } = "";
}

public sealed class SimpleResult
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("id")] public string? Id { get; set; }
}
