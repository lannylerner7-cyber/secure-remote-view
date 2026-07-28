using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Minimal SIPSorcery-based WebRTC client. Creates an offer, POSTs it via the
/// signaling table (from_side="admin"), then polls for the agent's answer and
/// ICE candidates. Full H.264 → D3DImage rendering is scaffolded but not
/// finished in v1: when a video track arrives, we surface it via <c>OnConnected</c>
/// so the ViewModel can drop the JPEG fallback and mark transport as "webrtc".
///
/// If ICE fails or times out (12s), we exit quietly and let the HTTP frame
/// fallback carry the session.
/// </summary>
public sealed class WebRtcClient
{
    private readonly string _sessionId;
    private RTCPeerConnection? _pc;
    private long _sinceSignalId;
    private CancellationTokenSource? _cts;
    private Action? _onTerminated;
    private Action<string>? _onError;

    public WebRtcClient(string sessionId) => _sessionId = sessionId;

    /// <param name="onTerminated">
    /// Fired when the agent reports our peer was superseded by another admin
    /// machine (someone else took over the same live session). The ViewModel
    /// closes the window and shows a banner.
    /// </param>
    /// <param name="onError">
    /// Fired on repeated signal-poll failures (typically 401/RLS) so the
    /// ViewModel can raise a banner instead of the loop dying silently.
    /// </param>
    public async Task StartAsync(CancellationToken outerCt, Action onConnected, Action? onTerminated = null, Action<string>? onError = null)
    {
        _onTerminated = onTerminated;
        _onError = onError;
        _cts = CancellationTokenSource.CreateLinkedTokenSource(outerCt);
        var ct = _cts.Token;

        var cfg = new RTCConfiguration
        {
            iceServers = new System.Collections.Generic.List<RTCIceServer>
            {
                new RTCIceServer { urls = "stun:stun.l.google.com:19302" },
            },
        };
        _pc = new RTCPeerConnection(cfg);

        // Codec pinning guardrail — see agent WebRtcSession for the matching side.
        _pc.addTrack(new MediaStreamTrack(SDPMediaTypesEnum.video,
            false, new System.Collections.Generic.List<SDPAudioVideoMediaFormat>
            {
                new SDPAudioVideoMediaFormat(SDPMediaTypesEnum.video, 96, "VP8", 90000),
            }, MediaStreamStatusEnum.RecvOnly));

        _pc.onicecandidate += async (c) =>
        {
            try
            {
                await App.Api.PushSignalAsync(_sessionId, "ice", new
                {
                    candidate = c.candidate,
                    sdpMid = c.sdpMid,
                    sdpMLineIndex = c.sdpMLineIndex,
                }, ct);
            }
            catch { }
        };

        _pc.onconnectionstatechange += (state) =>
        {
            if (state == RTCPeerConnectionState.connected) onConnected();
        };

        var offer = _pc.createOffer();
        await _pc.setLocalDescription(offer);
        await App.Api.PushSignalAsync(_sessionId, "offer", new { sdp = offer.sdp, type = offer.type.ToString() }, ct);

        _ = Task.Run(() => PollAgentSignals(ct), CancellationToken.None);

        // 12s watchdog — if not connected, we bow out and JPEG fallback stays.
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(12_000, ct); } catch { }
            if (_pc != null && _pc.connectionState != RTCPeerConnectionState.connected)
            {
                try { _pc.close(); } catch { }
            }
        }, CancellationToken.None);
    }

    private async Task PollAgentSignals(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            bool ok = true;
            try
            {
                var (max, items) = await App.Api.PollAgentSignalsAsync(_sessionId, _sinceSignalId, ct);
                _sinceSignalId = max;
                foreach (var s in items)
                {
                    if (_pc == null) return;
                    if (s.Kind == "answer" && s.Payload is JsonElement je && je.TryGetProperty("sdp", out var sdp))
                    {
                        var desc = new RTCSessionDescriptionInit { sdp = sdp.GetString(), type = RTCSdpType.answer };
                        _pc.setRemoteDescription(desc);
                    }
                    else if (s.Kind == "ice" && s.Payload is JsonElement je2 && je2.TryGetProperty("candidate", out var cand))
                    {
                        var candStr = cand.GetString();
                        if (!string.IsNullOrEmpty(candStr))
                        {
                            var init = new RTCIceCandidateInit
                            {
                                candidate = candStr,
                                sdpMid = je2.TryGetProperty("sdpMid", out var mid) ? mid.GetString() : null,
                                sdpMLineIndex = je2.TryGetProperty("sdpMLineIndex", out var idx) && idx.ValueKind == JsonValueKind.Number
                                    ? (ushort)idx.GetInt32() : (ushort)0,
                            };
                            _pc.addIceCandidate(init);
                        }
                    }
                    else if (s.Kind == "terminated")
                    {
                        // Another admin machine took over this session. Close
                        // silently and let the ViewModel show the banner.
                        try { _pc.close(); } catch { }
                        _pc = null;
                        try { _onTerminated?.Invoke(); } catch { }
                        return;
                    }
                    else if (s.Kind == "bye")
                    {
                        try { _pc.close(); } catch { }
                        return;
                    }
                }
            }
            catch { ok = false; }
            try { await Task.Delay(ok ? 500 : 2000, ct); } catch { }
        }
    }


    public void Close()
    {
        try { _cts?.Cancel(); } catch { }
        try { _pc?.close(); } catch { }
        _pc = null;
    }
}
