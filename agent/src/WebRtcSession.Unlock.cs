using System;
using System.Text.Json;
using SIPSorcery.Net;
using ConnectLive.Unlock;

namespace ConnectLive.Agent;

public sealed partial class WebRtcSession
{
    private UnlockOperation? _unlock;
    private bool HandleUnlockAction(JsonElement root, RTCDataChannel channel, PeerInputPermission owner, string kind)
    {
        if (!kind.StartsWith("unlock_", StringComparison.Ordinal)) return false;
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("request_id", out var request) || request.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(request.GetString(), out _)) return true;
        var id = request.GetString()!;
        var authorizationId = _api.LocalAuthorization?.Authorization.Id;
        bool Bound() => !_closed && ReferenceEquals(_browserInput, channel) && ReferenceEquals(_peerPermission, owner) &&
            channel.readyState == RTCDataChannelState.open && owner.Allows("view");
        void Report(string phase, string? reason)
        {
            if (!Bound()) return;
            if (phase == "unlocked")
            {
                _inputPermission.SetMode("view");
                owner.SetMode("view");
                ReportPermissionState();
            }
            channel.send(JsonSerializer.Serialize(new { kind = "unlock_status", session_id = _sessionId,
                authorization_id = authorizationId, request_id = id, phase, reason }));
        }
        if (kind != "unlock_begin")
        {
            if (_unlock?.RequestId == id) _unlock.Receive(kind, payload);
            return true;
        }
        var local = UnlockEnrollment.Current;
        if (!Bound() || _unlock?.Active == true || local?.Registered != true || !UnlockEnrollment.Fresh ||
            !UnlockEnrollment.Matches(_api, local) || string.IsNullOrEmpty(_signalBinding.PeerId) ||
            !_formatReady || !_videoStarted || WindowsSession.Locked(WindowsSession.CurrentId) != true ||
            !payload.TryGetProperty("recording_stopped", out var recording) || recording.ValueKind != JsonValueKind.True)
        {
            Report("blocked", "unlock_setup_or_transport_unavailable");
            return true;
        }
        // Neither curtain nor ordinary control is required for Winlogon input.
        // They are released rather than bypassed or silently re-enabled later.
        CurtainController.Release(owner, "windows_unlock");
        _inputPermission.SetMode("view"); owner.SetMode("view");
        InputRelay.ReleaseHeldInputs();
        ReportPermissionState();
        _unlock?.Dispose();
        _unlock = new UnlockOperation(_api, local, _sessionId, _signalBinding.PeerId!, id, owner.Token,
            Bound, Report, PushFrame);
        _ = _unlock.RunAsync();
        return true;
    }
}
