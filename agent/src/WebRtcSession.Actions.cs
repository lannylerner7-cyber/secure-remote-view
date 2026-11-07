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
        if (HandleUnlockAction(root, channel, peerPermission, kind.GetString()!)) return true;
        // Media fallback does not change the acknowledged command protocol.
        // Routing legacy-media browser requests through InputRelay lost their
        // action_status receipt and did not handle curtain_renew.
        if (kind.GetString() is "curtain_on" or "curtain_off" or "curtain_renew")
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
            !Guid.TryParse(request.GetString(), out _))
        {
            // Older callers send a bare safety release. It must still clear
            // this peer's curtain even though there is no correlated receipt.
            if (action == "curtain_off") CurtainController.Release(owner, "admin_off");
            return;
        }
        // Preserve the spelling: the native Admin uses Guid "N", browsers "D".
        var requestId = request.GetString();
        var legacyReceipt = payload.TryGetProperty("sent_at", out var sent) &&
            sent.TryGetInt64(out _);
        var sentAt = legacyReceipt ? sent.GetInt64() : -1;
        var authorizationId = _api.LocalAuthorization?.Authorization.Id;
        bool CurrentChannel() => !_closed && ReferenceEquals(_browserInput, channel) &&
            ReferenceEquals(_peerPermission, owner) && channel.readyState == RTCDataChannelState.open;
        void Receipt(bool applied)
        {
            if (!CurrentChannel()) return;
            var active = CurtainController.ActiveFor(owner);
            try { channel.send(JsonSerializer.Serialize(new {
                kind = "action_status", session_id = _sessionId, authorization_id = authorizationId,
                request_id = requestId, action, status = applied ? "applied" : "rejected",
                active,
            })); } catch { }
            // Retain the Windows Admin receipt, but send it after the actual
            // rendered/apply callback, not merely behind queued dispatcher work.
            if (legacyReceipt)
                try { channel.send(JsonSerializer.Serialize(new {
                    kind = "curtain_status", request_id = requestId,
                    sent_at = sentAt, applied = applied && active,
                })); } catch { }
            if (!applied) Log.Warn($"curtain request rejected: {action}");
        }
        void Changed(bool active, string reason)
        {
            if (!CurrentChannel()) return;
            try { channel.send(JsonSerializer.Serialize(new {
                kind = "curtain_state", session_id = _sessionId, authorization_id = authorizationId,
                active, reason,
            })); } catch { }
        }
        if (action == "curtain_off") CurtainController.Release(owner, "admin_off", Receipt);
        else if (action == "curtain_renew") Receipt(CurtainController.Renew(owner));
        // Native Admin renews with curtain_on; browsers use curtain_renew.
        // Both retain the same owner and five-second fail-safe lease.
        else if (CurtainController.Renew(owner)) Receipt(true);
        else
        {
            Log.Info($"privacy curtain requested; control permission={owner.Allows("control")}");
            CurtainController.Enable(owner, Receipt, Changed);
        }
    }
}
