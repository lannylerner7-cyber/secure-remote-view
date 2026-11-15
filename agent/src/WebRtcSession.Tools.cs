using System;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;

namespace ConnectLive.Agent;

public sealed partial class WebRtcSession
{
    private readonly SessionFileBudget _fileBudget = new();
    private VerifiedFileChannel? _verifiedFiles;
    private SessionToolsConnection? _tools;
    private bool _audioFormatReady;
    internal ToolBinding? HttpFileBinding => _api.DeviceId != null && _api.LocalAuthorization != null &&
        _signalBinding.AdminId is { } controller ? new ToolBinding(_api.DeviceId, _sessionId,
            _api.LocalAuthorization.Authorization.Id, controller, _signalBinding.PeerId ?? "") : null;
    private void AddMicrophoneTrack(RTCPeerConnection peer)
    {
        _audioFormatReady = false;
        // Pre-negotiate a dormant audio sender. Listen/Off never renegotiate or
        // replace the established H.264/input peer. PCMU is standard WebRTC.
        peer.addTrack(new MediaStreamTrack(new AudioFormat(SDPWellKnownMediaFormatsEnum.PCMU), MediaStreamStatusEnum.SendOnly));
        peer.OnAudioFormatsNegotiated += formats => {
            if (!ReferenceEquals(_pc, peer)) return;
            _audioFormatReady = formats.Exists(f => f.Codec == AudioCodecsEnum.PCMU);
        };
    }
    private bool AttachSessionTools(RTCDataChannel channel, PeerInputPermission owner, RTCPeerConnection peer)
    {
        if (channel.label is not ("session-tools-v1" or "files-v2")) return false;
        string? controller = _signalBinding.AdminId, peerId = _signalBinding.PeerId;
        if (string.IsNullOrEmpty(controller) || !Guid.TryParse(peerId, out _) || _api.DeviceId == null ||
            _api.LocalAuthorization == null) { channel.close(); return true; }
        var binding = new ToolBinding(_api.DeviceId, _sessionId, _api.LocalAuthorization.Authorization.Id, controller, peerId!);
        bool Connected() => !_closed && ReferenceEquals(_pc, peer) && ReferenceEquals(_peerPermission, owner) &&
            _signalBinding.Matches(controller, peerId) && peer.connectionState == RTCPeerConnectionState.connected &&
            owner.Allows("view");
        if (channel.label == "files-v2")
        {
            _verifiedFiles?.Dispose();
            if (!owner.Allows("files")) { channel.close(); return true; }
            _verifiedFiles = new VerifiedFileChannel(channel, binding, () => Connected() && owner.Allows("files"),
                _fileBudget, owner.Token, () => _api.ConfirmToolAuthorityAsync(binding, "files", owner.Token), Connected,
                (info,direction,complete) => _api.FileReceiptAsync(binding,info,direction,complete,owner.Token));
        }
        else
        {
            _tools?.Dispose();
            _tools = new SessionToolsConnection(_api, channel, binding, owner, Connected,
                () => Connected() && _audioFormatReady, bytes => {
                    if (Connected() && _audioFormatReady) peer.SendAudio(160, bytes);
                }, () => _verifiedFiles, () => {
                    _inputPermission.SetMode("view"); owner.SetMode("view"); InputRelay.ReleaseHeldInputs(); ReportPermissionState();
                });
        }
        return true;
    }
    private void StopSessionTools()
    {
        _tools?.Dispose(); _tools = null;
        _verifiedFiles?.Dispose(); _verifiedFiles = null;
        _audioFormatReady = false;
    }
}
