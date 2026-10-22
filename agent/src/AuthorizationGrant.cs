using System;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Globalization;
using System.Text.RegularExpressions;

namespace ConnectLive.Agent;

internal sealed record GrantScopes(bool View, bool Control, bool Clipboard, bool Files, bool Recording)
{
    internal bool Allows(string scope) => scope switch
    {
        "view" => View, "control" => View && Control, "clipboard" => Clipboard,
        "files" => Files, "recording" => View && Recording, _ => false
    };
}

internal sealed record AuthorizationGrant(string Id, string Mode, GrantScopes Capabilities, string RecordedAt)
{
    internal static AuthorizationGrant? Parse(JsonElement value)
    {
        try
        {
            static bool Exact(JsonElement e, params string[] keys) =>
                e.ValueKind == JsonValueKind.Object &&
                e.EnumerateObject().Count() == keys.Length &&
                keys.All(k => e.TryGetProperty(k, out _));
            if (!Exact(value, "id", "noticeVersion", "mode", "capabilities", "recordedAt", "revokedAt") ||
                value.GetProperty("noticeVersion").GetInt32() != 1 ||
                value.GetProperty("revokedAt").ValueKind != JsonValueKind.Null) return null;
            var id = value.GetProperty("id").GetString()!;
            var mode = value.GetProperty("mode").GetString()!;
            var at = value.GetProperty("recordedAt").GetString()!;
            if (!Guid.TryParse(id, out _) || mode is not ("attended" or "unattended") ||
                !Regex.IsMatch(at, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$") ||
                !DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return null;
            var c = value.GetProperty("capabilities");
            if (!Exact(c, "view", "control", "clipboard", "files", "recording")) return null;
            var scopes = new GrantScopes(c.GetProperty("view").GetBoolean(), c.GetProperty("control").GetBoolean(),
                c.GetProperty("clipboard").GetBoolean(), c.GetProperty("files").GetBoolean(), c.GetProperty("recording").GetBoolean());
            if (scopes.Control && !scopes.View) return null;
            return new(id, mode, scopes, at);
        }
        catch { return null; }
    }
}

internal sealed record LocalGrant(string Origin, string DeviceId, AuthorizationGrant Authorization)
{
    internal static string OriginOf(string url) => new Uri(url).GetLeftPart(UriPartial.Authority);
    internal bool Matches(string origin, string? deviceId, AuthorizationGrant? remote) =>
        remote != null && DeviceId == deviceId && Origin == OriginOf(origin) && Authorization == remote;
}
