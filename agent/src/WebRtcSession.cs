using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using System.Collections.Generic;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using SIPSorceryMedia.Encoders;


namespace ConnectLive.Agent;

/// <summary>
/// Agent-side WebRTC peer. Answers the admin's SDP offer, sends screen frames
/// as VP8 video, and applies admin inputs from a reliable+ordered
/// RTCDataChannel. The HTTPS frame stream + input-poll loop keep running
/// in parallel, so if ICE never completes (strict corporate NAT with no TURN),
/// nothing is lost — the admin panel falls back automatically.
///
/// Take-over ("Double-Vouch"): every admin machine tags its offers with a
/// stable `admin_client_id`. If a *different* admin box submits a new offer
/// while we already have a peer connected, the agent runs a controlled
/// hand-off sequence:
///   1. Post a `terminated` signal targeted at the old admin_client_id so
///      its poller stops and its UI shows "Session taken over by another
///      admin console" instead of freezing.
///   2. Wait ~50 ms so the old admin's browser has time to see the row.
///   3. Tear down the old RTCPeerConnection.
///   4. Build a fresh peer for the new admin and answer normally.
/// This prevents ICE cross-talk and stale data-channel input.
///
/// Dependencies (pure-managed, single-file-safe):
///   SIPSorcery, SIPSorceryMedia.Encoders (software VP8).
/// </summary>
public sealed partial class WebRtcSession : IDisposable
{
    /// <summary>Active peer for the current session, or null. Read by ScreenCapture to tee frames.</summary>
    public static WebRtcSession? Current { get; private set; }

    private readonly ApiClient _api;
    private readonly string _sessionId;
    private readonly CancellationTokenSource _cts;
    private RTCPeerConnection? _pc;
    private Vp8FrameEncoder? _vp8;
    // Brain-engine phase 1 — hardware H.264. Non-null only once the peer has
    // actually negotiated H.264 AND a real MFT has come up for the current
    // geometry. Failure requires a NEW offer; never emit VP8 into H.264 SDP.
    private HwH264Encoder? _h264;
    private volatile bool _h264Negotiated = false;
    private volatile bool _h264Live = false;
    private long _h264Frames = 0;
    private volatile bool _h264UnavailableForSession;
    private int _codecRetiring;
    private CancellationTokenSource? _disconnectGrace;
    internal string WireCodecTag => !_formatReady ? "none" : _h264Negotiated ? "H264" : "VP8";

    private long _sinceSignal = 0;
    private volatile bool _closed = false;

    // The encoder only accepts raw samples once SDP negotiation has told us
    // which video format won. Until then ExternalVideoSourceRawSample() drops
    // every frame silently, which looks exactly like "connected but black".
    private volatile bool _formatReady = false;
    private volatile bool _videoStarted = false;
    private long _pushed = 0;
    private long _encoded = 0;
    private long _dropped = 0;
    private DateTime _lastStatsUtc = DateTime.MinValue;
    // Step 1 diagnostics — most recent PushFrame dimensions and negotiated payload id.
    private int _lastPushW = 0;
    private int _lastPushH = 0;
    private int _negotiatedPt = -1;
    // SCOPE:TRANSPORT keyframe-on-demand bookkeeping. A lossy link can produce
    // a PLI burst (the admin sends one per damaged frame); encoding a keyframe
    // per PLI would saturate the very link that is already struggling, so
    // requests inside the cooldown collapse into the one already in flight.
    private long _lastKeyFrameTicks = 0;
    private long _keyFrameRequests = 0;
    private long _keyFramesForced = 0;
    private const int KeyFrameCooldownMs = 200;
    /// <summary>Monotonic ms clock shared by the video diagnostics so log lines can be correlated.</summary>
    internal static readonly System.Diagnostics.Stopwatch MonoClock = System.Diagnostics.Stopwatch.StartNew();



    // Identity of the admin machine that owns the current peer. Null until
    // the first offer arrives. Used to detect take-over and to tag outgoing
    // answer/ICE so the admin poller's `admin_client_id` filter routes them.
    private readonly PeerSignalBinding _signalBinding;
    private string? _currentAdminClientId => _signalBinding.AdminId;
    private PeerInputPermission? _peerPermission;
    internal bool IsClosed => _closed;

    // Serialises take-over so two near-simultaneous offers from different
    // admin boxes can't tear each other down mid-negotiation.
    private readonly SemaphoreSlim _handoffLock = new(1, 1);

    private readonly PeerInputPermission _inputPermission;
    private readonly bool _videoOnly;

    internal WebRtcSession(ApiClient api, string sessionId, PeerInputPermission? inputPermission, bool videoOnly = false)
    {
        _videoOnly = videoOnly;
        _inputPermission = inputPermission ?? new PeerInputPermission("view");
        _api = api;
        _sessionId = sessionId;
        _cts = new CancellationTokenSource();
        _signalBinding = new PeerSignalBinding(() => !_closed && !_cts.IsCancellationRequested &&
            _inputPermission.Allows("view"));
        Current = this;
    }

    /// <summary>
    /// SCOPE:TRANSPORT — ask the VP8 encoder for an immediate keyframe.
    /// Called from the RTCP feedback handler when the admin's decoder reports
    /// loss. Cooldown prevents a PLI storm on a lossy link from becoming a
    /// keyframe storm that saturates the very link that is already hurting.
    /// </summary>
    private void RequestKeyFrame(string reason)
    {
        Interlocked.Increment(ref _keyFrameRequests);
        var end = _vp8;
        var hw = _h264;
        // On the H.264 path the software endpoint is idle, so `_videoStarted`
        // alone is the gate; on the VP8 path we still need the endpoint.
        if (!_videoStarted) return;
        if (hw == null && end == null) return;

        long now = MonoClock.ElapsedMilliseconds;
        long last = Interlocked.Read(ref _lastKeyFrameTicks);
        if (last != 0 && now - last < KeyFrameCooldownMs) return;
        if (Interlocked.CompareExchange(ref _lastKeyFrameTicks, now, last) != last) return;

        try
        {
            if (hw != null) hw.ForceKeyFrame();
            else end!.ForceKeyFrame();
            // Reset the safety-net counter so the next periodic keyframe is
            // measured from *this* IDR, not the last scheduled one.
            ScreenCapture.ResetKeyframeClock();
            Interlocked.Increment(ref _keyFramesForced);
            Log.Info($"[t={now}] webrtc keyframe forced ({reason})");
        }
        catch (Exception ex) { Log.Warn($"webrtc force keyframe: {ex.Message}"); }
    }


    private async Task LoadIceAsync()
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
        timeout.CancelAfter(ConnectLive.Native.NativeGatewayPolicy.IceBudget);
        // Never retain expired credentials or an earlier fallback. Every offer
        // (including restart/takeover) gets a fresh allocation configuration.
        _iceServers = new() { new RTCIceServer { urls = "stun:stun.l.google.com:19302" } };
        try
        {
            var cfg = await _api.GetIceConfigAsync(_sessionId, timeout.Token).ConfigureAwait(false);
            if (cfg == null)
            {
                Log.Warn("webrtc ICE gateway unavailable; direct-only fallback");
                return;
            }
            var list = new List<RTCIceServer>();
            foreach (var s in cfg.IceServers!)
                foreach (var url in s.UrlList())
                    list.Add(new RTCIceServer { urls = url, username = s.Username, credential = s.Credential });
            if (list.Count > 0 && !_cts.IsCancellationRequested && !_closed && _inputPermission.Allows("view"))
            {
                _iceServers = list;
                Log.Info($"webrtc ice gateway: {list.Count} server(s), turn={cfg.Turn}");
            }
        }
        catch (OperationCanceledException) when (!_cts.IsCancellationRequested) { Log.Warn("webrtc ICE deadline exceeded; direct-only fallback"); }
        catch (OperationCanceledException) { throw; }
        catch (UnauthorizedAccessException) { throw; }
        catch { Log.Warn("webrtc ICE gateway failed; direct-only fallback"); }
    }

    public Task StartAsync()
    {
        if (_closed || !_inputPermission.Allows("view")) return Task.CompletedTask;
        // Peer creation is deferred until the first offer arrives — we need
        // the admin_client_id from that offer to build the routing binding
        // before any ICE candidate goes out.
        _ = SignalPumpAsync(_cts.Token);
        return Task.CompletedTask;
    }

    /// <summary>Fallback ICE set. Replaced by the gateway response (S9) when available.</summary>
    private volatile List<RTCIceServer> _iceServers = new()
    {
        new RTCIceServer { urls = "stun:stun.l.google.com:19302" },
    };

    private void BuildPeer()
    {
        if (_closed || !_inputPermission.Allows("view")) return;
        // S9 — STUN always, TURN when the deployment configures a relay.
        var cfg = new RTCConfiguration
        {
            iceServers = new List<RTCIceServer>(_iceServers),
        };

        _pc = new RTCPeerConnection(cfg);
        var boundPeer = _pc;
        var peerPermission = _inputPermission.Fork();
        _peerPermission = peerPermission;
        _formatReady = false;
        _videoStarted = false;
        _pushed = _encoded = _dropped = 0;
        _lastStatsUtc = DateTime.UtcNow;
        // A fresh peer must get a frame immediately, not after the keepalive gap.
        ScreenCapture.ResetWebRtcTee();
        // SCOPE:TRANSPORT — a new peer is a new link. Start at the top rung
        // rather than inheriting the ladder position a previous technician's
        // congested connection settled on.
        // SCOPE:TRANSPORT — S17 ceiling. The 3840/2560 rungs cost more CPU than
        // software VP8 can pay, so a VP8 peer is held at DefaultRung. The
        // ceiling is dropped to 0 (full ladder) only once a hardware H.264
        // encoder is genuinely producing frames — see PushFrame. Negotiating
        // H.264 is not enough; the silicon has to answer first.
        BitrateController.Ceiling = BitrateController.DefaultRung;
        BitrateController.Reset();
        // S17 step 1 — a new peer is a new measurement. The previous session's
        // encode averages and peak geometry say nothing about this link.
        EncodeStats.Reset();

        DisposeH264("new peer");
        _h264Negotiated = false;
        _h264Live = false;
        _h264Frames = 0;
        _codecRetiring = 0;

        _vp8 = Vp8FrameEncoder.TryCreate();

        // Brain-engine phase 1 — offer hardware H.264 *ahead of* VP8 when this
        // machine has a real encoder and the operator has not forced VP8. The
        // ordering matters: SDP answers pick the first mutually supported
        // format, so listing H.264 first is what makes it win against a peer
        // (browser or native admin) that supports both. VP8 stays in the list
        // as the universal floor, so a peer that cannot do H.264 still connects.
        var offered = new List<VideoFormat>();
        // Hardware availability is independent of VP8. A missing software
        // encoder must not prevent a hardware-capable Agent from answering.
        bool offerH264 = !_h264UnavailableForSession && CodecPolicy.AllowH264;
        if (offerH264)
        {
            // profile-level-id 42e01f = Constrained Baseline 3.1, the profile the
            // MFT is configured for and the one every browser decodes in
            // hardware. packetization-mode=1 enables fragmented NAL units, which
            // is mandatory for frames larger than one MTU — i.e. all of them.
            offered.Add(new VideoFormat(VideoCodecsEnum.H264, 102, 90000,
                                        "packetization-mode=1;profile-level-id=42e01f"));
            Log.Info($"webrtc offering hardware H.264 first ({HwEncoderProbe.VendorTag}) with VP8 fallback");
        }
        if (_vp8 != null) offered.Add(new VideoFormat(VideoCodecsEnum.VP8, 96, 90000));
        if (offered.Count == 0)
        {
            Log.Warn("webrtc no usable video encoder; authorized JPEG fallback remains available when permitted");
            TearDownPeer();
            return;
        }

        MediaStreamTrack videoTrack = new(offered, MediaStreamStatusEnum.SendOnly);
        _pc.addTrack(videoTrack);

        // WITHOUT this the encoder has no negotiated format and silently drops
        // every raw sample — the peer connects, ICE succeeds, and the admin
        // still sees nothing but the JPEG fallback. Do not remove.
        _pc.OnVideoFormatsNegotiated += (formats) =>
        {
            if (_closed || !ReferenceEquals(_pc, boundPeer) || !_inputPermission.Allows("view")) return;
            if (formats == null || formats.Count == 0) return;
            try
            {
                var fmt = formats[0];
                if (fmt.Codec == VideoCodecsEnum.H264 && offerH264)
                {
                    // The encoder itself is built lazily in PushFrame, because
                    // only the first frame tells us the capture geometry.
                    _h264Negotiated = true;
                    _formatReady = true;
                    _negotiatedPt = fmt.FormatID;
                    Log.Info($"[t={MonoClock.ElapsedMilliseconds}] webrtc video format negotiated: H264 pt={fmt.FormatID} (hardware)");
                    return;
                }
                if (fmt.Codec != VideoCodecsEnum.VP8)
                {
                    Log.Warn($"webrtc rejected negotiated codec {fmt.Codec}; VP8 or H264 required");
                    return;
                }
                _h264Negotiated = false;
                if (_vp8 == null) { _formatReady = false; return; }
                _formatReady = true;
                _negotiatedPt = fmt.FormatID;
                Log.Info($"[t={MonoClock.ElapsedMilliseconds}] webrtc video format negotiated: {fmt.Codec} pt={fmt.FormatID}");
            }
            catch (Exception ex) { Log.Warn($"webrtc set format: {ex.Message}"); }
        };



        _pc.ondatachannel += (dc) =>
        {
            if (_closed || !peerPermission.Allows("view")) { dc.close(); return; }
            Log.Info($"webrtc dc open: {dc.label}");

            // ---- Step 10 — file exchange channel --------------------------
            // The peer (web console or native admin) opens a second reliable
            // ordered channel labelled "files". It never carries input, so it
            // is routed straight to FileTransfer and MUST NOT fall through to
            // the InputRelay parser below.
            if (dc.label == "files")
            {
                if (peerPermission.Allows("files")) FileTransfer.Attach(_api, _sessionId, dc, peerPermission);
                else dc.close();
                return;
            }

            // ---- S22 — clipboard sync channel -----------------------------
            // Text-only, capped, and equally forbidden from reaching the input
            // parser below (a clip frame has no `kind`, so it would be a no-op,
            // but routing explicitly keeps the intent readable).
            if (dc.label == "clip")
            {
                if (peerPermission.Allows("clipboard")) ClipboardRelay.Attach(dc, peerPermission);
                else dc.close();
                return;
            }


            // Do not buffer commands across permission changes. Every input
            // callback is checked against this peer's own revocable permission.
            if (dc.label != "input") { dc.close(); return; }
            var inputPeer = _pc;
            AttachBrowserInputStatus(dc, peerPermission);
            dc.onmessage += (_, __, data) =>
            {
                if (_closed || !ReferenceEquals(_pc, inputPeer) || dc.readyState != RTCDataChannelState.open ||
                    !peerPermission.Allows("view") || data.Length > 16 * 1024) return;
                try
                {
                    var json = System.Text.Encoding.UTF8.GetString(data);
                    using var doc = JsonDocument.Parse(json);
                    var root = doc.RootElement;
                    if (root.ValueKind != JsonValueKind.Object || HandleBrowserAction(root, dc, peerPermission)) return;
                    // Direct call — InputRelay.Apply is internal, same
                    // assembly. The old reflection bridge existed only when
                    // this file lived outside the agent assembly.
                    peerPermission.TryApply(() => InputRelay.Apply(root, peerPermission));
                    // The overlay application is queued on the UI dispatcher by
                    // InputRelay. Queue acknowledgement behind it, not on send.
                    if (root.TryGetProperty("kind", out var command) &&
                        command.GetString() is "curtain_on" or "curtain_off" &&
                        root.TryGetProperty("payload", out var payload) &&
                        payload.TryGetProperty("request_id", out var id) &&
                        id.ValueKind == JsonValueKind.String)
                    {
                        var requestId = id.GetString();
                        var sentAt = payload.TryGetProperty("sent_at", out var sent) &&
                                     sent.TryGetInt64(out var stamp) ? stamp : -1;
                        if (requestId?.Length <= 64)
                            System.Windows.Application.Current?.Dispatcher.BeginInvoke(new Action(() =>
                            {
                                if (_closed || !ReferenceEquals(_pc, inputPeer)) return;
                                try
                                {
                                    dc.send(JsonSerializer.Serialize(new {
                                        kind = "curtain_status", request_id = requestId,
                                        sent_at = sentAt,
                                        applied = _inputPermission.Allows("control") &&
                                                  InputBlocker.IsEngaged && CurtainOverlay.IsShown
                                    }));
                                }
                                catch (Exception ex) { Log.Warn("curtain acknowledgement: " + ex.Message); }
                            }));
                    }
                }
                catch { Log.Warn("webrtc input message rejected"); }
            };
        };

        // ---- SCOPE:TRANSPORT — keyframe on demand -------------------------
        // Before this handler existed, PLI/FIR from the admin were swallowed
        // and the decoder would sit on a corrupt reference frame until the
        // safety-net periodic refresh (see ScreenCapture.PeriodicRefreshFrames).
        // SIPSorcery raises OnReceiveReport for every incoming RTCP compound
        // packet; the payload-specific feedback packet carries either PLI
        // (fmt=1) or FIR (fmt=4). Either one means "I lost sync, please
        // resend an IDR immediately".
        _pc.OnReceiveReport += (IPEndPoint ep, SDPMediaTypesEnum mediaType, RTCPCompoundPacket rtcp) =>
        {
            try
            {
                if (mediaType != SDPMediaTypesEnum.video) return;

                // ---- SCOPE:TRANSPORT — congestion feedback ----------------
                // The RR block is the only honest measure of what the admin
                // actually received. Feed it to the ladder before looking at
                // PLI/FIR, because a compound packet often carries only one of
                // the two and the early-return below would swallow the RR.
                var rrList = rtcp?.ReceiverReport?.ReceptionReports
                             ?? rtcp?.SenderReport?.ReceptionReports;
                if (rrList != null && rrList.Count > 0)
                {
                    var rr = rrList[0];
                    double loss = rr.FractionLost / 256.0;
                    BitrateController.NoteReceiverReport(
                        loss, rr.Jitter,
                        EstimateRttMs(rr.LastSenderReportTimestamp, rr.DelaySinceLastSenderReport));
                }

                var fb = rtcp?.Feedback;
                var hdr = fb?.Header;
                if (hdr == null) return;


                // PSFB carries the payload-specific messages; PLI (fmt=1) is
                // what Chrome/SIPSorcery send on decode failure, FIR (fmt=4)
                // is the legacy equivalent some stacks still emit.
                if (hdr.PacketType == RTCPReportTypesEnum.PSFB &&
                    (hdr.PayloadFeedbackMessageType == PSFBFeedbackTypesEnum.PLI ||
                     hdr.PayloadFeedbackMessageType == PSFBFeedbackTypesEnum.FIR))
                {
                    RequestKeyFrame(hdr.PayloadFeedbackMessageType.ToString());
                }
            }
            catch (Exception ex) { Log.Warn($"webrtc rtcp handler: {ex.Message}"); }
        };

        // RFC 3550 §6.4.1 RTT: now − LSR − DLSR, all in the middle-32 NTP
        // format (16.16 fixed-point seconds). A zero LSR means the receiver
        // has not seen one of our sender reports yet, so there is nothing to
        // measure against — report 0 and let loss alone drive the ladder.
        static double EstimateRttMs(uint lsr, uint dlsr)
        {
            if (lsr == 0) return 0;
            var now = DateTime.UtcNow;
            var epoch = new DateTime(1900, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            double seconds = (now - epoch).TotalSeconds;
            uint nowMiddle = (uint)(((ulong)(seconds * 65536.0)) & 0xFFFFFFFFUL);
            long delta = (long)nowMiddle - lsr - dlsr;
            if (delta <= 0) return 0;
            double ms = delta * 1000.0 / 65536.0;
            // Anything past a few seconds is a wrapped or bogus timestamp, not
            // a real round trip; discard rather than crash the ladder down.
            return ms > 5000 ? 0 : ms;
        }




        var boundAdminClientId = _currentAdminClientId;
        var boundPeerId = _signalBinding.PeerId;
        _pc.onicecandidate += async (c) =>
        {
            if (c == null || !ReferenceEquals(_pc, boundPeer) || _closed ||
                !_inputPermission.Allows("view")) return;
            try
            {
                var payload = new
                {
                    candidate = c.candidate,
                    sdpMid = c.sdpMid,
                    sdpMLineIndex = c.sdpMLineIndex,
                    peer_id = boundPeerId,
                };
                await _api.PostSignalReliableAsync(_sessionId, "ice", payload, _cts.Token, boundAdminClientId);
            }
            catch (Exception ex) { Log.Warn($"webrtc ice post: {ex.Message}"); }
        };

        _pc.onconnectionstatechange += async (s) =>
        {
            if (!ReferenceEquals(_pc, boundPeer)) return;
            Log.Info($"[t={MonoClock.ElapsedMilliseconds}] webrtc pc state: {s}");
            if (s == RTCPeerConnectionState.connected)
            {
                CancelDisconnectGrace();
                try
                {
                    if (_h264Negotiated)
                    {
                        // Nothing to start: the hardware encoder is driven
                        // directly from PushFrame, so the software source stays
                        // paused for the life of this peer.
                        if (!_videoStarted)
                        {
                            _videoStarted = true;
                            ScreenCapture.ResetWebRtcTee();
                            Log.Info("webrtc video started on hardware H.264 path");
                        }
                    }
                    // Raw capture feeds VP8 only after this peer is connected.
                    else if (_vp8 != null && !_videoStarted)
                    {
                        _videoStarted = true;
                        try { _vp8.ForceKeyFrame(); } catch { }
                        ScreenCapture.ResetWebRtcTee();
                        Log.Info("webrtc video source started (keyframe forced)");
                    }
                }
                catch (Exception ex) { Log.Warn($"webrtc start video: {ex.Message}"); }
                return;
            }
            if (s == RTCPeerConnectionState.disconnected)
            {
                try { InputRelay.ReleaseHeldInputs(); } catch { }
                CancelDisconnectGrace();
                CancellationTokenSource grace;
                try { grace = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token); }
                catch (ObjectDisposedException) { return; }
                var graceToken = grace.Token;
                _disconnectGrace = grace;
                try
                {
                    await Task.Delay(6000, graceToken);
                    await _handoffLock.WaitAsync(graceToken);
                    try
                    {
                        if (ReferenceEquals(_pc, boundPeer) &&
                            boundPeer.connectionState == RTCPeerConnectionState.disconnected) TearDownPeer();
                    }
                    finally { _handoffLock.Release(); }
                }
                catch (OperationCanceledException) { }
                finally
                {
                    if (ReferenceEquals(Interlocked.CompareExchange(ref _disconnectGrace, null, grace), grace))
                        grace.Dispose();
                }
                return;
            }
            if (s == RTCPeerConnectionState.failed || s == RTCPeerConnectionState.closed)
            {
                // Only the peer is torn down here; a follow-up offer (same or
                // different admin) can rebuild it. HTTPS stream is unaffected.
                await _handoffLock.WaitAsync();
                try { if (ReferenceEquals(_pc, boundPeer)) TearDownPeer(); }
                finally { _handoffLock.Release(); }
            }
        };
    }

    private void TearDownPeer()
    {
        CancelDisconnectGrace();
        // Detach first so close callbacks from an old peer cannot tear down
        // its replacement or recurse through this method.
        var oldPeer = _pc;
        _pc = null;
        var oldPermission = _peerPermission;
        _peerPermission = null;
        oldPermission?.Revoke();
        _browserInput = null;
        try { InputRelay.ReleaseHeldInputs(); } catch { }
        try { InputBlocker.Release("peer_closed"); } catch { }
        try { System.Windows.Application.Current?.Dispatcher.BeginInvoke(new Action(CurtainOverlay.Hide)); } catch { }
        try { FileTransfer.Detach(); } catch { }
        try { ClipboardRelay.Detach(); } catch { }
        try { _vp8?.Dispose(); } catch { }
        try { oldPeer?.close(); } catch { }
        DisposeH264("peer torn down");
        _vp8 = null;
        _formatReady = false;
        _videoStarted = false;
        _h264Negotiated = false;
        _h264Live = false;
    }

    private void CancelDisconnectGrace()
    {
        var grace = Interlocked.Exchange(ref _disconnectGrace, null);
        try { grace?.Cancel(); } catch { }
        grace?.Dispose();
    }

    private void FailCodec(RTCPeerConnection peer, bool hardware)
    {
        if (!ReferenceEquals(_pc, peer) || Interlocked.Exchange(ref _codecRetiring, 1) != 0) return;
        _formatReady = false;
        if (hardware) _h264UnavailableForSession = true;
        Log.Warn("webrtc encoder failed; retiring peer for a clean codec negotiation");
        _ = Task.Run(async () =>
        {
            try
            {
                string? adminId, peerId;
                await _handoffLock.WaitAsync(_cts.Token);
                try
                {
                    if (!ReferenceEquals(_pc, peer)) return;
                    adminId = _currentAdminClientId;
                    peerId = _signalBinding.PeerId;
                    TearDownPeer();
                }
                finally { _handoffLock.Release(); }
                await _api.PostSignalReliableAsync(_sessionId, "bye",
                    new { peer_id = peerId, reason = "codec_unavailable" }, _cts.Token, adminId);
            }
            catch (OperationCanceledException) { }
            catch { Log.Warn("webrtc codec retirement notification unavailable; viewer timeout will recover"); }
        });
    }

    /// <summary>Release the hardware encoder and hand the ladder ceiling back to the VP8 policy.</summary>
    private void DisposeH264(string why)
    {
        var hw = Interlocked.Exchange(ref _h264, null);
        if (hw == null) return;
        try { hw.Dispose(); } catch { }
        _h264Live = false;
        Log.Info($"h264: encoder released ({why})");
        try { BitrateController.Ceiling = BitrateController.DefaultRung; } catch { }
    }


    /// <summary>
    /// Called from ScreenCapture: encode this frame into the WebRTC video track.
    /// Buffer MUST be tightly packed (width*4 bytes per row) in RGBA memory
    /// order. Encoder package 8.0.7's Bgra branch consumes RGBA bytes.
    ///
    /// No-ops until the peer is connected AND the SDP-negotiated video format
    /// has been handed to the encoder. Both conditions are counted so a
    /// starving pipeline shows up in the log instead of failing invisibly.
    /// </summary>
    public void PushFrame(byte[] bgra, int width, int height)
    {
        if (_closed || !_inputPermission.Allows("view")) return;
        if (width < 2 || height < 2 || (width & 1) != 0 || (height & 1) != 0 ||
            bgra.Length != checked(width * height * 4))
        {
            Interlocked.Increment(ref _dropped);
            Log.Warn($"webrtc rejected malformed raw frame {width}x{height}, bytes={bgra.Length}");
            return;
        }
        var pc = _pc;
        var enc = _vp8;
        if (pc == null || (enc == null && !_h264Negotiated)) { Interlocked.Increment(ref _dropped); return; }
        if (pc.connectionState != RTCPeerConnectionState.connected ||
            !_formatReady || !_videoStarted)
        {
            Interlocked.Increment(ref _dropped);
            MaybeLogStats();
            return;
        }
        try
        {
            Interlocked.Increment(ref _pushed);
            // Step 1 diagnostics: record the exact geometry handed to the encoder
            // and shout the first time it changes mid-peer (suspected stripe cause).
            if (width != _lastPushW || height != _lastPushH)
            {
                if (_lastPushW != 0)
                    Log.Warn($"[t={MonoClock.ElapsedMilliseconds}] webrtc RESOLUTION CHANGE mid-peer " +
                             $"{_lastPushW}x{_lastPushH} -> {width}x{height} (no renegotiation)");
                _lastPushW = width;
                _lastPushH = height;
            }

            if (_h264Negotiated)
            {
                PushFrameH264(pc, bgra, width, height);
            }
            else
            {
                // S17 step 1 — time the software VP8 encode submission. This is the
                // number that decides whether the hardware H.264 wrapper is worth
                // building: if it stays well inside the ~33 ms frame budget at the
                // 1920px rung, the CPU is not the wall.
                var encodeSw = System.Diagnostics.Stopwatch.StartNew();
                var sample = enc!.Encode(bgra, width, height);
                if (sample is { Length: > 0 } && ReferenceEquals(_pc, pc) &&
                    !_closed && _formatReady && !_h264Negotiated && _inputPermission.Allows("view"))
                {
                    pc.SendVideo((uint)(90000 / Math.Max(1, BitrateController.Current.Fps)), sample);
                    Interlocked.Increment(ref _encoded);
                }
                encodeSw.Stop();
                EncodeStats.NoteVp8Encode(
                    encodeSw.ElapsedTicks * 1_000_000L / System.Diagnostics.Stopwatch.Frequency, width, height);
            }
        }

        catch (Exception ex)
        {
            Log.Warn($"webrtc encode failed: {ex.GetType().Name}");
            FailCodec(pc, _h264Negotiated);
        }
        MaybeLogStats();
    }

    /// <summary>
    /// Hardware H.264 frame path. Builds the encoder on the first frame (the
    /// only moment the capture geometry is actually known), keeps its bitrate
    /// in step with the congestion ladder, and hands the Annex-B access unit
    /// straight to SIPSorcery's H.264 packetiser.
    ///
    /// Every failure here is soft: the frame is dropped, the HTTPS JPEG stream
    /// is still running underneath, and a dead encoder retires the H.264 path
    /// for the rest of the peer rather than looping on a broken driver.
    /// </summary>
    private void PushFrameH264(RTCPeerConnection pc, byte[] bgra, int width, int height)
    {
        var hw = _h264;
        if (hw == null || !hw.IsAlive)
        {
            if (hw != null && !hw.IsAlive)
            {
                // The MFT died mid-session. Do not rebuild it in a tight loop:
                // one retry per peer is enough to tell a transient from a rot.
                DisposeH264("encoder reported dead: " + hw.DeadReason);
                FailCodec(pc, hardware: true);
                return;
            }

            int kbps = BitrateController.Current.TargetKbps;
            int fps = BitrateController.Current.Fps;
            hw = HwH264Encoder.TryCreate(width, height, fps, kbps);
            if (hw == null)
            {
                FailCodec(pc, hardware: true);
                return;
            }
            Interlocked.Exchange(ref _h264, hw);
            _h264Live = true;
            // Earned, not assumed: the ladder is only allowed above 1920px once
            // a real hardware encoder is in the loop.
            try { BitrateController.Ceiling = 0; } catch { }
            Log.Info("h264: ladder ceiling lifted — full resolution range available");
        }

        hw.SetBitrateKbps(BitrateController.Current.TargetKbps);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var au = hw.Encode(bgra, width, height, out bool geometryChanged);
        sw.Stop();

        if (geometryChanged)
        {
            // A monitor switch or a ladder step changed the frame size. Rebuild
            // rather than renegotiate the MFT in place; the next frame picks up
            // the new encoder and the decoder resyncs on its IDR.
            DisposeH264($"geometry changed to {width}x{height}");
            return;
        }
        if (au == null || au.Length == 0) return;   // pipelined encoder, no output yet

        EncodeStats.NoteVp8Encode(
            sw.ElapsedTicks * 1_000_000L / System.Diagnostics.Stopwatch.Frequency, width, height);

        // 90 kHz clock: one frame at the current cadence.
        uint duration = (uint)(90000 / Math.Max(1, BitrateController.Current.Fps));
        if (_closed || !ReferenceEquals(_pc, pc) || !_formatReady || !_inputPermission.Allows("view")) return;
        pc.SendVideo(duration, au);
        Interlocked.Increment(ref _encoded);
        Interlocked.Increment(ref _h264Frames);
    }



    /// <summary>~5 s heartbeat of the video pipeline so "connected but black" is diagnosable.</summary>
    private void MaybeLogStats()
    {
        var now = DateTime.UtcNow;
        if ((now - _lastStatsUtc).TotalSeconds < 5) return;
        _lastStatsUtc = now;
        Log.Info($"[t={MonoClock.ElapsedMilliseconds}] webrtc video pipe: pushed={Interlocked.Read(ref _pushed)} " +
                 $"encoded={Interlocked.Read(ref _encoded)} dropped={Interlocked.Read(ref _dropped)} " +
                 $"formatReady={_formatReady} started={_videoStarted} " +
                 $"size={_lastPushW}x{_lastPushH} pt={_negotiatedPt} " +
                 $"codec={(_h264Live ? "h264-hw" : "vp8-sw")} h264frames={Interlocked.Read(ref _h264Frames)}");

        // S17 step 1 — encode cost next to the pipe counters, so one log excerpt
        // answers both "are frames flowing?" and "what did they cost?".
        try { Log.Info($"[t={MonoClock.ElapsedMilliseconds}] {EncodeStats.Line()}"); } catch { }

    }



    private async Task SignalPumpAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !_closed)
        {
            try
            {
                var (max, items) = await _api.PollSignalsAsync(_sessionId, _sinceSignal, ct);
                if (items != null)
                {
                    foreach (var it in items)
                    {
                        try { await ApplyAdminSignal(it); }
                        catch (Exception ex) { Log.Warn($"webrtc sig apply: {ex.Message}"); }
                    }
                    if (max > _sinceSignal) _sinceSignal = max;
                }
            }
            catch (Exception ex) { Log.Warn($"webrtc sig poll: {ex.Message}"); }
            try { await Task.Delay(500, ct); } catch { }
        }
    }

    private async Task ApplyAdminSignal(JsonElement it)
    {
        if (_closed || !_inputPermission.Allows("view")) return;
        var kind = it.GetProperty("kind").GetString();
        var payload = it.GetProperty("payload");
        if (!SignalIdentity.TryRead(it, _videoOnly, out var incomingAdminId, out var incomingPeerId))
        {
            // Previously a silent drop. A malformed or unaddressed signal in a
            // video-only session means the viewer never gets an answer, so say
            // so (shape only — never the IDs or SDP themselves).
            Log.Warn($"webrtc {kind} rejected: identity check failed " +
                     $"(admin_client_id={(it.TryGetProperty("admin_client_id", out var a) && a.ValueKind == JsonValueKind.String ? "present" : "missing")}, " +
                     $"peer_id={(payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("peer_id", out var p) ? p.ValueKind.ToString() : "missing")}, " +
                     $"videoOnly={_videoOnly})");
            return;
        }

        switch (kind)
        {
            case "offer":
            {
                Log.Info($"[t={MonoClock.ElapsedMilliseconds}] webrtc offer received (videoOnly={_videoOnly}, " +
                         $"peer={(_pc == null ? "none" : "existing")})");
                await _handoffLock.WaitAsync(_cts.Token);
                try
                {
                    if (_closed || !_inputPermission.Allows("view")) return;
                    // Take-over: a *different* admin machine is offering while we
                    // already have a peer. Tell the old admin its session was
                    // superseded, then rebuild the peer for the new one.
                    if (_pc != null &&
                        !string.IsNullOrEmpty(_currentAdminClientId) &&
                        !string.IsNullOrEmpty(incomingAdminId) &&
                        !_signalBinding.Matches(incomingAdminId, incomingPeerId))
                    {
                        Log.Info($"webrtc takeover: {_currentAdminClientId} -> {incomingAdminId}");
                        try
                        {
                            await _api.PostSignalReliableAsync(
                                _sessionId, "terminated",
                                new { reason = "superseded_by_other_client", peer_id = _signalBinding.PeerId },
                                _cts.Token,
                                _currentAdminClientId);
                        }
                        catch { /* best-effort */ }
                        try { await Task.Delay(50, _cts.Token); } catch { }
                        TearDownPeer();
                    }

                    if (_pc != null) TearDownPeer();
                    if (!_signalBinding.TryBind(incomingAdminId, incomingPeerId)) return;
                    await LoadIceAsync().ConfigureAwait(false);
                    if (_cts.IsCancellationRequested || _closed || !_inputPermission.Allows("view")) return;
                    // Rebuild on every offer: mutating a cached list does not
                    // update an already-created SIPSorcery peer's ICE servers.
                    if (_pc != null) TearDownPeer();
                    if (_pc == null) BuildPeer();
                    if (_pc == null) return;

                    var sdp = payload.GetProperty("sdp").GetString() ?? "";
                    var desc = new RTCSessionDescriptionInit
                    {
                        type = RTCSdpType.offer,
                        sdp = sdp,
                    };
                    var setResult = _pc.setRemoteDescription(desc);
                    if (setResult != SetDescriptionResultEnum.OK) { Log.Warn($"setRemote offer: {setResult}"); return; }
                    var answer = _pc.createAnswer(null);
                    await _pc.setLocalDescription(answer);
                    await _api.PostSignalReliableAsync(_sessionId, "answer",
                        new { type = "answer", sdp = answer.sdp, peer_id = incomingPeerId }, _cts.Token, _currentAdminClientId);
                    Log.Info($"[t={MonoClock.ElapsedMilliseconds}] webrtc answer posted");
                }
                finally { _handoffLock.Release(); }
                break;
            }
            case "ice":
            {
                if (_pc == null) return;
                if (!_signalBinding.Matches(incomingAdminId, incomingPeerId)) return;
                // Drop stray ICE from a superseded admin — its offer no longer
                // owns our peer, so its candidates would poison negotiation.
                if (!string.IsNullOrEmpty(incomingAdminId) &&
                    !string.IsNullOrEmpty(_currentAdminClientId) &&
                    !string.Equals(_currentAdminClientId, incomingAdminId, StringComparison.Ordinal))
                    return;
                try
                {
                    var candidate = payload.GetProperty("candidate").GetString() ?? "";
                    var sdpMid = payload.TryGetProperty("sdpMid", out var m) ? m.GetString() : null;
                    ushort sdpMLineIndex = 0;
                    if (payload.TryGetProperty("sdpMLineIndex", out var i) && i.ValueKind == JsonValueKind.Number)
                        sdpMLineIndex = (ushort)i.GetInt32();
                    _pc.addIceCandidate(new RTCIceCandidateInit
                    {
                        candidate = candidate,
                        sdpMid = sdpMid,
                        sdpMLineIndex = sdpMLineIndex,
                    });
                }
                catch (Exception ex) { Log.Warn($"addIceCandidate: {ex.Message}"); }
                break;
            }
            case "bye":
                await _handoffLock.WaitAsync(_cts.Token);
                try
                {
                    // A viewer departure ends only its peer, never the active
                    // session grant or the signaling pump needed for reopening.
                    if (_signalBinding.TryRelease(incomingAdminId, incomingPeerId))
                        TearDownPeer();
                }
                finally { _handoffLock.Release(); }
                break;
        }
    }

    public void Close()
    {
        _inputPermission.Revoke();
        if (_closed) return;
        _closed = true;
        if (Current == this)
        {
            Current = null;
            // Release the S17 ceiling: with no peer the JPEG path is free to
            // climb to the sharp rungs again.
            try { BitrateController.Ceiling = 0; } catch { }
        }
        try { _cts.Cancel(); } catch { }
        // Step 10 — drop the files channel with the peer so a stale reference
        // cannot keep an inbound reassembly buffer alive across sessions.
        try { FileTransfer.Detach(); } catch { }
        // S22 — same for clipboard: stop the poll timer and drop the channel.
        try { ClipboardRelay.Detach(); } catch { }


        TearDownPeer();

        // SCOPE:TRANSPORT lifecycle — both of these are per-session and were
        // previously only cancelled, never released. Over a long shift of
        // connect/disconnect cycles the agent accrued a CTS timer registration
        // and a semaphore handle per session.
        // Async signaling/handoff callbacks may still be unwinding. Do not
        // dispose their synchronization primitives underneath those callbacks.

        Log.Info($"webrtc closed — keyframe requests={Interlocked.Read(ref _keyFrameRequests)} " +
                 $"forced={Interlocked.Read(ref _keyFramesForced)}");
    }

    public void Dispose() => Close();
}

