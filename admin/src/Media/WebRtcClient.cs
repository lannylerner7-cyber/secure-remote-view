using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Minimal SIPSorcery-based WebRTC client. Creates an offer, POSTs it via the
/// signaling table (from_side="admin"), then polls for the agent's answer and
/// ICE candidates.
///
/// Persistence layer (matches the web console):
///   - Every outbound signal rides <c>PushSignalReliableAsync</c>, which
///     serialises per-session and stamps an <c>attempt_id</c> for idempotent
///     retries with bounded exponential backoff.
///   - A 15s heartbeat calls the <c>bind_admin</c> RPC to refresh this
///     admin's ownership of the session. If the RPC reports "superseded"
///     (another admin console took over), we fire onTerminated and close.
///     If the admin crashes, the server-side prune releases the binding
///     after 90s so a fresh console can take over cleanly.
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
    public async Task StartAsync(CancellationToken outerCt, Action onVideoLive, Action? onVideoStalled = null, Action? onTerminated = null, Action<string>? onError = null)
    {
        _onTerminated = onTerminated;
        _onError = onError;
        _cts = CancellationTokenSource.CreateLinkedTokenSource(outerCt);
        var ct = _cts.Token;

        // Claim / refresh the binding before signaling starts.
        try
        {
            var initial = await App.Api.BindAdminAsync(_sessionId, ct).ConfigureAwait(false);
            if (!initial.bound)
            {
                if (initial.reason == "superseded") { _onTerminated?.Invoke(); return; }
                _onError?.Invoke("Bind session: " + initial.reason);
                return;
            }
        }
        catch (Exception ex) { _onError?.Invoke("Bind session: " + ex.Message); return; }

        // STUN-only, hardcoded. No TURN / external relay service.
        var iceServers = new System.Collections.Generic.List<RTCIceServer>
        {
            new RTCIceServer { urls = "stun:stun.l.google.com:19302" },
        };

        var cfg = new RTCConfiguration { iceServers = iceServers };
        _pc = new RTCPeerConnection(cfg);


        // Codec pinning guardrail — see agent WebRtcSession for the matching side.
        _pc.addTrack(new MediaStreamTrack(SDPMediaTypesEnum.video,
            false, new System.Collections.Generic.List<SDPAudioVideoMediaFormat>
            {
                new SDPAudioVideoMediaFormat(SDPMediaTypesEnum.video, 96, "VP8", 90000),
            }, MediaStreamStatusEnum.RecvOnly));

        _pc.onicecandidate += async (c) =>
        {
            if (c == null) return;
            try
            {
                await App.Api.PushSignalReliableAsync(_sessionId, "ice", new
                {
                    candidate = c.candidate,
                    sdpMid = c.sdpMid,
                    sdpMLineIndex = c.sdpMLineIndex,
                }, ct);
            }
            catch (Exception ex) { _onError?.Invoke("ICE post: " + ex.Message); }
        };

        // Receive-side telemetry: distinguishes "never connected" from
        // "connected but the sender emits nothing" — the exact failure where
        // the encoder never got its negotiated format.
        long rtpVideoPackets = 0;
        long lastObservedPackets = 0;
        DateTime lastVideoPacketUtc = DateTime.MinValue;
        int videoLiveRaised = 0;
        var lastRtpLog = DateTime.MinValue;
        _pc.OnRtpPacketReceived += (_, media, __) =>
        {
            if (media != SDPMediaTypesEnum.video) return;
            var n = Interlocked.Increment(ref rtpVideoPackets);
            lastVideoPacketUtc = DateTime.UtcNow;
            if (n == 1)
            {
                System.Diagnostics.Debug.WriteLine("[webrtc] first video RTP packet received");
                if (Interlocked.Exchange(ref videoLiveRaised, 1) == 0) onVideoLive();
                return;
            }
            var now = DateTime.UtcNow;
            if ((now - lastRtpLog).TotalSeconds < 5) return;
            lastRtpLog = now;
            System.Diagnostics.Debug.WriteLine($"[webrtc] video rtp packets={n}");
        };

        _pc.onconnectionstatechange += (state) =>
        {
            System.Diagnostics.Debug.WriteLine("[webrtc] connectionState: " + state);
            if (state == RTCPeerConnectionState.connected)
            {
                if (Interlocked.Read(ref rtpVideoPackets) == 0)
                    System.Diagnostics.Debug.WriteLine("[webrtc] connected — awaiting first video RTP packet");
            }
        };


        var offer = _pc.createOffer();
        await _pc.setLocalDescription(offer).ConfigureAwait(false);
        try
        {
            await App.Api.PushSignalReliableAsync(_sessionId, "offer",
                new { sdp = offer.sdp, type = offer.type.ToString() }, ct);
        }
        catch (Exception ex) { _onError?.Invoke("Offer post: " + ex.Message); return; }

        _ = Task.Run(() => PollAgentSignals(ct), CancellationToken.None);
        _ = Task.Run(() => HeartbeatLoop(ct), CancellationToken.None);
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try { await Task.Delay(3000, ct).ConfigureAwait(false); } catch { return; }
                var packets = Interlocked.Read(ref rtpVideoPackets);
                if (packets > lastObservedPackets)
                {
                    lastObservedPackets = packets;
                    continue;
                }
                if (Interlocked.CompareExchange(ref videoLiveRaised, 0, 1) == 1 &&
                    lastVideoPacketUtc != DateTime.MinValue &&
                    (DateTime.UtcNow - lastVideoPacketUtc).TotalSeconds >= 6)
                {
                    try { onVideoStalled?.Invoke(); } catch { }
                }
            }
        }, CancellationToken.None);

        // Blind connect watchdog — original 12s baseline.
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(12_000, ct); } catch { return; }
            var st = _pc?.connectionState;
            if (st != null && st != RTCPeerConnectionState.connected)
            {
                System.Diagnostics.Debug.WriteLine("[webrtc] watchdog closing peer, state=" + st);
                try { _pc?.close(); } catch { }
            }
        }, CancellationToken.None);


    }

    private async Task HeartbeatLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(15_000, ct); } catch { return; }
            if (ct.IsCancellationRequested) return;
            try
            {
                var r = await App.Api.BindAdminAsync(_sessionId, ct).ConfigureAwait(false);
                if (!r.bound && r.reason == "superseded")
                {
                    try { _pc?.close(); } catch { }
                    _pc = null;
                    try { _onTerminated?.Invoke(); } catch { }
                    return;
                }
            }
            catch (Exception ex) { _onError?.Invoke("Heartbeat: " + ex.Message); }
        }
    }

    private async Task PollAgentSignals(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            bool ok = true;
            try
            {
                var (max, items) = await App.Api.PollAgentSignalsAsync(_sessionId, _sinceSignalId, ct).ConfigureAwait(false);
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
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                ok = false;
                try { _onError?.Invoke("Signal poll: " + ex.Message); } catch { }
            }
            try { await Task.Delay(ok ? 500 : 2000, ct); } catch { }
        }
    }


    public void Close()
    {
        // Best-effort "bye" so the agent tears down its peer immediately
        // instead of waiting on its own 12s watchdog. Uses a fresh short
        // timeout token — we do NOT gate it on _cts because Close() is
        // about to cancel it.
        try
        {
            using var byeCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            _ = App.Api.PushSignalReliableAsync(_sessionId, "bye", new { }, byeCts.Token);
        }
        catch { }
        try { _cts?.Cancel(); } catch { }
        try { _pc?.close(); } catch { }
        _pc = null;
    }
}
