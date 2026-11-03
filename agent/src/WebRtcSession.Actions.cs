using System;
using System.Linq;
using System.Text.Json;
using SIPSorcery.Net;

namespace ConnectLive.Agent;

public sealed partial class WebRtcSession
{
    private RTCDataChannel? _browserInput;

    private void AttachBrowserInputStatus(RTCDataChannel channel, PeerInputPermission owner)
    {
        _browserInput = channel;
        channel.onopen += ReportPermissionState;
        channel.onclose += () =>
        {
            if (!ReferenceEquals(_browserInput, channel)) return;
            _browserInput = null;
            CurtainController.Release(owner, "input_channel_closed");
            owner.Revoke();
            try { InputRelay.ReleaseHeldInputs(); } catch { }
            try { InputBlocker.Release("input_channel_closed"); } catch { }
            try { System.Windows.Application.Current?.Dispatcher.BeginInvoke(new Action(CurtainOverlay.Hide)); } catch { }
        };
        if (channel.readyState == RTCDataChannelState.open) ReportPermissionState();
    }

    internal void ReportPermissionState()
    {
        var channel = _browserInput;
        if (_closed || channel?.readyState != RTCDataChannelState.open || !_inputPermission.Allows("view")) return;
        try
        {
            channel.send(JsonSerializer.Serialize(new {
                kind = "permission_status", session_id = _sessionId,
                authorization_id = _api.LocalAuthorization?.Authorization.Id,
                mode = _inputPermission.Allows("control") ? "control" : "view",
                curtain_supported = CurtainController.Supported,
                curtain_active = _peerPermission != null && CurtainController.ActiveFor(_peerPermission),
            }));
        }
        catch { Log.Warn("permission status could not be delivered"); }
    }

    private bool HandleBrowserAction(JsonElement root, RTCDataChannel channel, PeerInputPermission peerPermission)
    {
        if (!root.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String) return false;
        if (_videoOnly && kind.GetString() is "curtain_on" or "curtain_off" or "curtain_renew")
        {
            HandleCurtainAction(root, channel, peerPermission, kind.GetString()!);
            return true;
        }
        if (kind.GetString() != "switch_monitor") return false;
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("request_id", out var request) || request.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(request.GetString(), out var requestId)) return true;
        bool applied = false;
        if (payload.TryGetProperty("device_name", out var device) && device.ValueKind == JsonValueKind.String &&
            device.GetString() is { Length: > 0 and <= 200 } name &&
            MonitorSelector.Outputs().Any(m => string.Equals(m.DeviceName, name, StringComparison.OrdinalIgnoreCase)))
        {
            applied = peerPermission.TryApplyCapability("view", () => MonitorSelector.Select(name)) &&
                string.Equals(MonitorSelector.SelectedDeviceName, name, StringComparison.OrdinalIgnoreCase);
            if (applied) RequestKeyFrame("monitor_selected");
        }
        channel.send(JsonSerializer.Serialize(new {
            kind = "action_status", session_id = _sessionId, request_id = requestId.ToString(),
            action = "switch_monitor", status = applied ? "applied" : "rejected",
        }));
        return true;
    }

    private void HandleCurtainAction(JsonElement root, RTCDataChannel channel, PeerInputPermission owner, string action)
    {
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("request_id", out var request) || request.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(request.GetString(), out var id)) return;
        void Receipt(bool applied)
        {
            if (_closed || channel.readyState != RTCDataChannelState.open) return;
            try { channel.send(JsonSerializer.Serialize(new {
                kind = "action_status", session_id = _sessionId, authorization_id = _api.LocalAuthorization?.Authorization.Id,
                request_id = id.ToString(), action, status = applied ? "applied" : "rejected",
                active = CurtainController.ActiveFor(owner),
            })); } catch { }
        }
        void Changed(bool active, string reason)
        {
            if (_closed || channel.readyState != RTCDataChannelState.open) return;
            try { channel.send(JsonSerializer.Serialize(new {
                kind = "curtain_state", session_id = _sessionId, authorization_id = _api.LocalAuthorization?.Authorization.Id,
                active, reason,
            })); } catch { }
        }
        if (action == "curtain_off") CurtainController.Release(owner, "admin_off", Receipt);
        else if (action == "curtain_renew") Receipt(CurtainController.Renew(owner));
        else CurtainController.Enable(owner, Receipt, Changed);
    }
}
