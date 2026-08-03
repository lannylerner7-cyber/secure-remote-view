using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ConnectLive.Admin.Diag;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Media;

/// <summary>
/// SIPSorcery-based WebRTC client for the native console.
///
/// Gate A (transport): every ICE state transition, candidate type and
/// negotiation milestone is written to admin.log with a monotonic
/// <c>[t=…ms]</c> stamp, so the offer→answer→ICE→connected timeline can be read
/// end to end from one file. Candidates post the instant they are gathered
/// (trickle) on the signal fast path — never batched.
///
/// Gates B/C + Phases 1–3 (video): inbound VP8 is depacketised by SIPSorcery,
/// handed to <see cref="VideoPipeline"/> (decode off the UI thread, present on
/// it, D3DImage first with a WriteableBitmap fallback). The JPEG frame pump in
/// the ViewModel keeps running underneath and is only labelled as the fallback
/// it is.
///
/// Phase 4 (robustness): a decode stall asks for a keyframe first (RTCP PLI);
/// only if that keeps failing does the admin — which owns the offer per ruling
/// R1 — restart ICE by re-offering. STUN-only; no TURN.
///
/// Persistence: outbound signals ride PushSignalReliableAsync (idempotent
/// attempt_id + backoff); a 15s bind_admin heartbeat keeps ownership, and a
/// "superseded" answer tears this console down cleanly.
/// </summary>
public sealed class WebRtcClient : IDisposable
{
    private static readonly System.Diagnostics.Stopwatch MonoClock = System.Diagnostics.Stopwatch.StartNew();

    private readonly string _sessionId;
    private RTCPeerConnection? _pc;
    private long _sinceSignalId;
    private CancellationTokenSource? _cts;
    private Action? _onTerminated;
    private Action<string>? _onError;
    private Action? _onVideoLive;
    private Action? _onVideoStalled;

    private readonly object _restartGate = new();
    private DateTime _lastPliUtc = DateTime.MinValue;
    private DateTime _lastRestartUtc = DateTime.MinValue;
    private int _pliBurst;
    private int _restarts;
    private RtpCapture? _capture;

    /// <summary>The native video pipeline. The window binds its surface directly.</summary>
    public VideoPipeline Pipeline { get; } = new();

    /// <summary>Number of admin-initiated ICE restarts this session (Phase 4 evidence).</summary>
    public int IceRestarts => _restarts;

    public WebRtcClient(string sessionId) => _sessionId = sessionId;

    private static void T(string msg) => Log.Write($"[t={MonoClock.ElapsedMilliseconds}] [webrtc] {msg}");

    public async Task StartAsync(CancellationToken outerCt, Action onVideoLive,
        Action? onVideoStalled = null, Action? onTerminated = null, Action<string>? onError = null)
    {
        _onTerminated = onTerminated;
        _onError = onError;
        _onVideoLive = onVideoLive;
        _onVideoStalled = onVideoStalled;
        _cts = CancellationTokenSource.CreateLinkedTokenSource(outerCt);
        var ct = _cts.Token;

        _capture = RtpCapture.CreateIfEnabled(_sessionId);
        if (_capture != null) T("RTP capture harness armed -> " + _capture.Path);

        Pipeline.KeyFrameRequested += OnKeyFrameRequested;
        Pipeline.Diagnostic += d => T("pipeline: " + d);
        Pipeline.FirstFrame += () =>
        {
            T($"FIRST DECODED FRAME presented ({(Pipeline.UsingD3D ? "d3d" : "bitmap")} path)");
            try { _onVideoLive?.Invoke(); } catch { }
        };
        Pipeline.Start();

        // Claim / refresh the binding before signalling starts.
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

        T("bind ok — building peer");
        if (!await NegotiateAsync(ct).ConfigureAwait(false)) return;

        _ = Task.Run(() => PollAgentSignals(ct), CancellationToken.None);
        _ = Task.Run(() => HeartbeatLoop(ct), CancellationToken.None);
        _ = Task.Run(() => StatsLoop(ct), CancellationToken.None);
        StartConnectWatchdog(ct);
    }

    // ---- negotiation (admin offers, ruling R1) ---------------------------

    private async Task<bool> NegotiateAsync(CancellationToken ct)
    {
        try { _pc?.close(); } catch { }

        // S9 — ICE gateway: STUN always, TURN when the deployment has a relay.
        // A gateway failure returns an empty list and we keep the STUN fallback.
        var iceServers = new System.Collections.Generic.List<RTCIceServer>();
        try
        {
            foreach (var s in await App.Api.GetIceServersAsync(ct).ConfigureAwait(false))
                foreach (var url in s.Urls)
                    iceServers.Add(new RTCIceServer { urls = url, username = s.Username, credential = s.Credential });
        }
        catch { }
        if (iceServers.Count == 0)
            iceServers.Add(new RTCIceServer { urls = "stun:stun.l.google.com:19302" });
        T($"ice servers: {iceServers.Count}");

        var cfg = new RTCConfiguration { iceServers = iceServers };
        var pc = new RTCPeerConnection(cfg);
        _pc = pc;

        // Codec pinning guardrail — see agent WebRtcSession for the matching side.
        pc.addTrack(new MediaStreamTrack(SDPMediaTypesEnum.video,
            false, new System.Collections.Generic.List<SDPAudioVideoMediaFormat>
            {
                new SDPAudioVideoMediaFormat(SDPMediaTypesEnum.video, 96, "VP8", 90000),
            }, MediaStreamStatusEnum.RecvOnly));

        WireDiagnostics(pc, ct);
        WireVideo(pc);

        // S10 — open the input datachannel BEFORE createOffer so the SDP
        // advertises the SCTP m-line. Ordered + reliable: input events must
        // land in send order and lost events must retransmit (a swallowed
        // mouseup would leave a button pinned down). Agent side already
        // handles ondatachannel; see agent/src/WebRtcSession.cs.
        try
        {
            var dc = await pc.createDataChannel("input",
                new RTCDataChannelInit { ordered = true }).ConfigureAwait(false);
            ConnectLive.Admin.Input.InputTransport.Attach(_sessionId, dc);
            T("input datachannel created (label=input, ordered)");
        }
        catch (Exception ex)
        {
            T("input datachannel create failed, staying on REST: " + ex.Message);
            ConnectLive.Admin.Input.InputTransport.Detach();
        }

        var offer = pc.createOffer();
        await pc.setLocalDescription(offer).ConfigureAwait(false);
        T("offer created + local description set");
        try
        {
            await App.Api.PushSignalReliableAsync(_sessionId, "offer",
                new { sdp = offer.sdp, type = offer.type.ToString() }, ct);
            T("offer posted");
        }
        catch (Exception ex) { _onError?.Invoke("Offer post: " + ex.Message); return false; }
        return true;
    }

    private void WireDiagnostics(RTCPeerConnection pc, CancellationToken ct)
    {
        pc.onicecandidate += async (c) =>
        {
            if (c == null) return;
            // Trickle: post the instant it is gathered, on the signal fast path.
            NoteCandidate(c.candidate);
            T($"local candidate gathered type={CandidateType(c.candidate)} mid={c.sdpMid}");
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

        pc.oniceconnectionstatechange += (s) => T($"iceConnectionState={s}");
        pc.onicegatheringstatechange += (s) => T($"iceGatheringState={s}");
        pc.onsignalingstatechange += () => T($"signalingState={pc.signalingState}");

        pc.onconnectionstatechange += (state) =>
        {
            T($"connectionState={state}");
            if (state == RTCPeerConnectionState.connected)
                T($"TRANSPORT GREEN — connected (wire={WirePath})");
            if (state == RTCPeerConnectionState.failed || state == RTCPeerConnectionState.disconnected)
                TryIceRestart("connection " + state);
        };
    }

    // ---- S11 — wire path -------------------------------------------------
    // SIPSorcery does not surface the nominated pair, so the path is derived
    // from the candidate types actually exchanged: any relay on either side
    // means the media is relayed, otherwise reflexive beats host.
    private volatile string _wirePath = "unknown";

    /// <summary>host | srflx | relay | unknown — how media is reaching this console.</summary>
    public string WirePath => _wirePath;

    private void NoteCandidate(string? candidate)
    {
        var type = CandidateType(candidate);
        if (type == "relay") _wirePath = "relay";
        else if (type == "srflx" && _wirePath != "relay") _wirePath = "srflx";
        else if (type == "host" && _wirePath == "unknown") _wirePath = "host";
    }

    private static string CandidateType(string? candidate)
    {
        if (string.IsNullOrEmpty(candidate)) return "unknown";
        var i = candidate.IndexOf(" typ ", StringComparison.Ordinal);
        if (i < 0) return "unknown";
        var rest = candidate.Substring(i + 5);
        var sp = rest.IndexOf(' ');
        return sp < 0 ? rest : rest.Substring(0, sp);
    }


    private void WireVideo(RTCPeerConnection pc)
    {
        long rtpVideoPackets = 0;
        int lastSeq = -1;

        pc.OnRtpPacketReceived += (_, media, pkt) =>
        {
            if (media != SDPMediaTypesEnum.video) return;
            var n = Interlocked.Increment(ref rtpVideoPackets);
            if (n == 1) T("first video RTP packet received");

            // S13 — SIPSorcery reassembles VP8 frames but does not tell us when
            // packets went missing, and a frame reassembled over a hole decodes
            // into the striped corruption we chased earlier. Watch the sequence
            // number ourselves (16-bit, wraps) and gate the decoder on loss.
            int seq = pkt.Header.SequenceNumber;
            if (lastSeq >= 0)
            {
                int delta = (seq - lastSeq) & 0xFFFF;
                if (delta > 1 && delta < 0x8000)
                {
                    T($"rtp gap: {delta - 1} packet(s) missing before seq={seq}");
                    Pipeline.NotifyPacketLoss(delta - 1);
                }
                // delta == 0 or >= 0x8000 is a duplicate/reordered late packet;
                // SIPSorcery's framer handles those, and treating them as loss
                // would gate the decoder on healthy links.
                if (delta < 0x8000) lastSeq = seq;
            }
            else lastSeq = seq;

            // Gate B tap — strictly passive, debug-flag gated.
            if (_capture != null)
            {
                try { _capture.Write(pkt.GetBytes()); } catch { }
            }
        };


        // SIPSorcery depacketises VP8 into whole frames for us; the pipeline
        // owns the jitter buffer, decode thread and presentation.
        try
        {
            pc.OnVideoFrameReceived += (_, __, frame, ___) =>
            {
                if (frame != null && frame.Length > 0) Pipeline.Submit(frame);
            };
        }
        catch (Exception ex) { T("frame handler wiring failed: " + ex.Message); }
    }

    // ---- Phase 4: keyframe first, then admin-initiated ICE restart -------

    private void OnKeyFrameRequested()
    {
        var now = DateTime.UtcNow;
        lock (_restartGate)
        {
            // Once we've surrendered to the fallback there is nobody to answer
            // a PLI — stop the storm instead of pinging a dead path forever.
            if (_surrendered) return;
            if ((now - _lastPliUtc).TotalMilliseconds < 750) return;
            _lastPliUtc = now;
            _pliBurst++;
        }


        var pc = _pc;
        if (pc == null) return;
        try
        {
            pc.SendVideoRtcpFeedback(new RTCPFeedback(pc.VideoLocalTrack?.Ssrc ?? 0,
                pc.VideoRemoteTrack?.Ssrc ?? 0, PSFBFeedbackTypesEnum.PLI));
            T("PLI sent (keyframe request)");
        }
        catch (Exception ex) { T("PLI failed: " + ex.Message); }

        // Six unanswered keyframe requests (~4.5s of nothing decodable) means
        // the media path, not the encoder, is broken. Escalate once.
        if (_pliBurst >= 6)
        {
            _pliBurst = 0;
            try { _onVideoStalled?.Invoke(); } catch { }
            TryIceRestart("decode stall");
        }
    }

    /// <summary>
    /// Max ICE restarts before we stop fighting the network. Without a cap a
    /// permanently broken media path produced an endless PLI → restart →
    /// PLI loop: new ICE candidates every 15s forever, CPU burning, and the
    /// JPEG fallback repeatedly interrupted by a renegotiation that could
    /// never succeed. Four attempts (~1 minute) is the ceiling; after that the
    /// session rides the fallback pump until the user reconnects.
    /// </summary>
    private const int MaxIceRestarts = 4;
    private bool _surrendered;

    private void TryIceRestart(string why)
    {
        var ct = _cts?.Token ?? CancellationToken.None;
        if (ct.IsCancellationRequested) return;
        lock (_restartGate)
        {
            if (_surrendered) return;
            // A restart that happened more than two minutes ago belongs to a
            // different network event — don't hold it against this one.
            if ((DateTime.UtcNow - _lastRestartUtc).TotalMinutes > 2) _restarts = 0;
            if ((DateTime.UtcNow - _lastRestartUtc).TotalSeconds < 15) return;
            if (_restarts >= MaxIceRestarts)
            {
                _surrendered = true;
                T($"ICE restart cap reached ({MaxIceRestarts}) — surrendering native video, JPEG fallback carries the session");
                try { _onVideoStalled?.Invoke(); } catch { }
                return;
            }
            _lastRestartUtc = DateTime.UtcNow;
            _restarts++;
        }
        T($"ICE RESTART #{_restarts} — reason: {why}");
        _ = Task.Run(async () =>
        {
            try { await NegotiateAsync(ct).ConfigureAwait(false); }
            catch (Exception ex) { T("ICE restart failed: " + ex.Message); }
        }, CancellationToken.None);
    }


    private void StartConnectWatchdog(CancellationToken ct)
    {
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(12_000, ct); } catch { return; }
            var st = _pc?.connectionState;
            if (st != null && st != RTCPeerConnectionState.connected)
            {
                T($"watchdog: still {st} after 12s — one restart, then the JPEG fallback carries the session");
                TryIceRestart("12s connect watchdog");
            }
        }, CancellationToken.None);
    }

    // ---- G1/G2: per-minute stats line ------------------------------------

    private async Task StatsLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(60_000, ct).ConfigureAwait(false); } catch { return; }
            var p = Pipeline;
            Log.Write(p.StatsLine() + $" restarts={_restarts} state={_pc?.connectionState} wire={_wirePath} "
                      + ConnectLive.Admin.Input.InputTransport.StatsLine());

            // S11 — the same reading, durable, so the web console and the soak
            // report can see render health without reading a local log file.
            try
            {
                await App.Api.PushTelemetryAsync(_sessionId, new
                {
                    session_id = _sessionId,
                    admin_client_id = App.ClientId,
                    fps = Math.Round(p.Fps, 1),
                    latency_ms = Math.Round(p.LastLatencyMs, 0),
                    queue_depth = p.QueueDepth,
                    frames_decoded = p.FramesDecoded,
                    frames_dropped = p.FramesDropped,
                    frames_presented = p.FramesPresented,
                    source_width = p.SourceWidth,
                    source_height = p.SourceHeight,
                    render_path = p.UsingD3D ? "d3d" : "bitmap",
                    input_path = ConnectLive.Admin.Input.InputTransport.CurrentPath,
                    wire_path = _wirePath,
                    ice_restarts = _restarts,
                    peer_state = _pc?.connectionState.ToString(),
                }, ct).ConfigureAwait(false);
            }
            catch (Exception ex) { T("telemetry post failed: " + ex.Message); }
        }
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
                    T("binding superseded by another admin console");
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
                    var pc = _pc;
                    if (pc == null) return;
                    if (s.Kind == "answer" && s.Payload is JsonElement je && je.TryGetProperty("sdp", out var sdp))
                    {
                        var desc = new RTCSessionDescriptionInit { sdp = sdp.GetString(), type = RTCSdpType.answer };
                        var res = pc.setRemoteDescription(desc);
                        T($"answer applied: {res}");
                    }
                    else if (s.Kind == "ice" && s.Payload is JsonElement je2 && je2.TryGetProperty("candidate", out var cand))
                    {
                        var candStr = cand.GetString();
                        if (!string.IsNullOrEmpty(candStr))
                        {
                            NoteCandidate(candStr);
                            T($"remote candidate type={CandidateType(candStr)}");
                            pc.addIceCandidate(new RTCIceCandidateInit
                            {
                                candidate = candStr,
                                sdpMid = je2.TryGetProperty("sdpMid", out var mid) ? mid.GetString() : null,
                                sdpMLineIndex = je2.TryGetProperty("sdpMLineIndex", out var idx) && idx.ValueKind == JsonValueKind.Number
                                    ? (ushort)idx.GetInt32() : (ushort)0,
                            });
                        }
                    }
                    else if (s.Kind == "terminated")
                    {
                        T("agent reports session terminated (taken over)");
                        try { pc.close(); } catch { }
                        _pc = null;
                        try { _onTerminated?.Invoke(); } catch { }
                        return;
                    }
                    else if (s.Kind == "bye")
                    {
                        T("agent said bye");
                        try { pc.close(); } catch { }
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

    /// <summary>
    /// Clean teardown (G3): bye to the agent, cancel every loop, flush the
    /// decoder and queues, park the D3D surface. Safe to call twice.
    /// </summary>
    public void Close()
    {
        try
        {
            using var byeCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            _ = App.Api.PushSignalReliableAsync(_sessionId, "bye", new { }, byeCts.Token);
        }
        catch { }
        try { _cts?.Cancel(); } catch { }
        // Input must fall back to REST the instant the peer goes away.
        try { ConnectLive.Admin.Input.InputTransport.Detach(); } catch { }
        try { _pc?.close(); } catch { }
        _pc = null;
        try { Pipeline.KeyFrameRequested -= OnKeyFrameRequested; } catch { }
        try { Pipeline.Dispose(); } catch { }
        try { _capture?.Dispose(); } catch { }
        _capture = null;
        Log.Write("[webrtc] closed — pipeline flushed, D3D surface parked");
    }

    public void Dispose() => Close();
}
