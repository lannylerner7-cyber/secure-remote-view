using System;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ConnectLive.Agent;

internal static class SignalIdentity
{
    // Admin routing IDs include "web-<uuid>" and native UUIDs. They are not
    // the separate UUID identifying one replaceable browser peer.
    internal static bool IsAdminClientId(string? value) => value != null &&
        Regex.IsMatch(value, @"\A[A-Za-z0-9._:-]{8,64}\z", RegexOptions.CultureInvariant);

    internal static bool TryRead(JsonElement signal, bool requireAdminId,
        out string? adminId, out string? peerId)
    {
        adminId = peerId = null;
        if (signal.ValueKind != JsonValueKind.Object) return false;
        if (signal.TryGetProperty("admin_client_id", out var admin) && admin.ValueKind != JsonValueKind.Null)
        {
            if (admin.ValueKind != JsonValueKind.String) return false;
            adminId = admin.GetString();
            if (!IsAdminClientId(adminId)) return false;
        }
        if (requireAdminId && adminId == null) return false;
        if (!signal.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object) return false;
        if (payload.TryGetProperty("peer_id", out var peer) && peer.ValueKind != JsonValueKind.Null)
        {
            if (peer.ValueKind != JsonValueKind.String) return false;
            peerId = peer.GetString();
            if (!Guid.TryParse(peerId, out _)) return false;
        }
        return true;
    }
}
