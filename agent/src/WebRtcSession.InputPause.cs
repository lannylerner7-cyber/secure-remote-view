using System;
using System.Text.Json;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Agent;

public sealed partial class WebRtcSession
{
    private bool HandleInputPause(JsonElement root, RTCDataChannel channel, PeerInputPermission owner, string kind)
    {
        if (kind != "input_pause") return false;
        if (!root.TryGetProperty("payload", out var p) || p.ValueKind != JsonValueKind.Object ||
            !p.TryGetProperty("request_id", out var request) || request.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(request.GetString(), out _) ||
            !p.TryGetProperty("paused", out var paused) || paused.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !p.TryGetProperty("authorization_id", out var grant) || grant.ValueKind != JsonValueKind.String ||
            grant.GetString() != _api.LocalAuthorization?.Authorization.Id ||
            !p.TryGetProperty("process_id", out var process) || process.ValueKind != JsonValueKind.String || process.GetString() != AgentProcessState.Instance ||
            !p.TryGetProperty("peer_id", out var peer) || peer.ValueKind != JsonValueKind.String || peer.GetString() != _signalBinding.PeerId ||
            !p.TryGetProperty("controller_id", out var controller) || controller.ValueKind != JsonValueKind.String || controller.GetString() != _currentAdminClientId ||
            !p.TryGetProperty("input_epoch", out var epoch) || epoch.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(epoch.GetString(), out _) ||
            !p.TryGetProperty("input_revision", out var revision) || revision.ValueKind != JsonValueKind.Number ||
            !revision.TryGetInt64(out var number) || number < 0)
            return true;
        var binding = _signalBinding.PeerId;
        var controllerId = _currentAdminClientId;
        var grantId = grant.GetString();
        bool Current() => !_closed && ReferenceEquals(_browserInput, channel) &&
            ReferenceEquals(_peerPermission, owner) && channel.readyState == RTCDataChannelState.open &&
            _signalBinding.PeerId == binding && _currentAdminClientId == controllerId &&
            _api.LocalAuthorization?.Authorization.Id == grantId && owner.Allows("view");
        void Receipt(bool applied, string? reason = null)
        {
            if (!Current()) return;
            var state = owner.InputState;
            try
            {
                channel.send(JsonSerializer.Serialize(new {
                    kind = "input_pause_status", action = "input_pause", session_id = _sessionId,
                    authorization_id = grantId, request_id = request.GetString(),
                    status = applied ? "applied" : "rejected", reason,
                    peer_id = binding, controller_id = controllerId, process_id = AgentProcessState.Instance,
                    input_pause_supported = true, input_pause_protocol = 1,
                    input_paused = state.Paused, input_epoch = state.Epoch, input_revision = state.Revision,
                    input_release_confirmed = state.ReleaseConfirmed,
                }));
            }
            catch { Log.Warn("input pause receipt could not be delivered"); }
        }
        if (!Current()) return true;
        if (_unlock?.Active == true)
        {
            Receipt(false, "secure_input_active");
            return true;
        }
        if (paused.GetBoolean())
        {
            // Restrict immediately without waiting on the telemetry heartbeat.
            var applied = owner.PauseInput(epoch.GetString()!, number);
            Receipt(applied, applied ? null : "input_barrier_unconfirmed");
            Log.Info($"remote input pause {(applied ? "confirmed" : "unconfirmed")}");
        }
        else
        {
            // Copy JSON values before the receive callback disposes its document.
            var expected = epoch.GetString()!;
            var requestId = request.GetString()!;
            _ = ResumeInputAsync(channel, owner, expected, number, requestId, binding!, controllerId!, grantId!);
        }
        return true;
    }

    private async Task ResumeInputAsync(RTCDataChannel channel, PeerInputPermission owner,
        string epoch, long revision, string requestId, string peerId, string controllerId, string grantId)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        bool Current() => !_closed && ReferenceEquals(_browserInput, channel) &&
            ReferenceEquals(_peerPermission, owner) && channel.readyState == RTCDataChannelState.open &&
            _signalBinding.PeerId == peerId && _currentAdminClientId == controllerId &&
            _api.LocalAuthorization?.Authorization.Id == grantId && owner.Allows("view") && _unlock?.Active != true;
        try
        {
            if (!Current()) return;
            var confirmed = await _api.ConfirmSessionModeAsync(_sessionId, "control", controllerId, owner.Token).ConfigureAwait(false);
            if (!Current()) return;
            var applied = confirmed && _inputPermission.SetMode("control", started) &&
                owner.ResumeInput(epoch, revision);
            var state = owner.InputState;
            channel.send(JsonSerializer.Serialize(new {
                kind = "input_pause_status", action = "input_pause", session_id = _sessionId,
                authorization_id = grantId, request_id = requestId,
                status = applied ? "applied" : "rejected",
                reason = applied ? null : "fresh_control_or_input_epoch_rejected",
                peer_id = peerId, controller_id = controllerId, process_id = AgentProcessState.Instance,
                input_pause_supported = true, input_pause_protocol = 1,
                input_paused = state.Paused, input_epoch = state.Epoch, input_revision = state.Revision,
                input_release_confirmed = state.ReleaseConfirmed,
            }));
            Log.Info($"remote input resume {(applied ? "confirmed" : "rejected")}");
        }
        catch { Log.Warn("remote input resume could not be confirmed"); }
    }
}
