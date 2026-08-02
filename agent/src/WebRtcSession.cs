using System;
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
public sealed class WebRtcSession : IDisposable
{
    /// <summary>Active peer for the current session, or null. Read by ScreenCapture to tee frames.</summary>
    public static WebRtcSession? Current { get; private set; }

    private readonly ApiClient _api;
    private readonly string _sessionId;
    private readonly CancellationTokenSource _cts;
    private RTCPeerConnection? _pc;
    private VideoEncoderEndPoint? _videoEnd;
    private long _sinceSignal = 0;
    private bool _closed = false;

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
    /// <summary>Monotonic ms clock shared by the video diagnostics so log lines can be correlated.</summary>
    internal static readonly System.Diagnostics.Stopwatch MonoClock = System.Diagnostics.Stopwatch.StartNew();


    // Identity of the admin machine that owns the current peer. Null until
    // the first offer arrives. Used to detect take-over and to tag outgoing
    // answer/ICE so the admin poller's `admin_client_id` filter routes them.
    private string? _currentAdminClientId = null;

    // Serialises take-over so two near-simultaneous offers from different
    // admin boxes can't tear each other down mid-negotiation.
    private readonly SemaphoreSlim _handoffLock = new(1, 1);

    public WebRtcSession(ApiClient api, string sessionId)
    {
        _api = api;
        _sessionId = sessionId;
        _cts = new CancellationTokenSource();
        Current = this;
    }

    public Task StartAsync()
    {
        // Peer creation is deferred until the first offer arrives — we need
        // the admin_client_id from that offer to build the routing binding
        // before any ICE candidate goes out.
        _ = SignalPumpAsync(_cts.Token);
        return Task.CompletedTask;
    }

    private void BuildPeer()
    {
        // STUN-only, hardcoded. No TURN / external relay service.
        var cfg = new RTCConfiguration
        {
            iceServers = new List<RTCIceServer>
            {
                new RTCIceServer { urls = "stun:stun.l.google.com:19302" },
            },
        };

        _pc = new RTCPeerConnection(cfg);
        _formatReady = false;
        _videoStarted = false;
        _pushed = _encoded = _dropped = 0;
        _lastStatsUtc = DateTime.UtcNow;
        // A fresh peer must get a frame immediately, not after the keepalive gap.
        ScreenCapture.ResetWebRtcTee();

        _videoEnd = new VideoEncoderEndPoint();
        // Codec pinning guardrail — MUST stay in lockstep with admin/src/Media/WebRtcClient.cs.
        try
        {
            _videoEnd.RestrictFormats(f => f.Codec == VideoCodecsEnum.VP8);
        }
        catch (Exception ex)
        {
            Log.Warn($"webrtc VP8 restriction failed: {ex.Message}");
        }
        var sourceFormats = _videoEnd.GetVideoSourceFormats();
        bool hasVp8 = false;
        if (sourceFormats != null)
            foreach (var sourceFormat in sourceFormats)
                if (sourceFormat.Codec == VideoCodecsEnum.VP8) { hasVp8 = true; break; }
        if (!hasVp8)
        {
            Log.Warn("webrtc VP8 encoder unavailable; keeping HTTPS frame fallback");
            TearDownPeer();
            return;
        }
        MediaStreamTrack videoTrack = new(sourceFormats, MediaStreamStatusEnum.SendOnly);
        _pc.addTrack(videoTrack);

        _videoEnd.OnVideoSourceEncodedSample += (durationRtpUnits, sample) =>
        {
            System.Threading.Interlocked.Increment(ref _encoded);
            _pc?.SendVideo(durationRtpUnits, sample);
        };

        // WITHOUT this the encoder has no negotiated format and silently drops
        // every raw sample — the peer connects, ICE succeeds, and the admin
        // still sees nothing but the JPEG fallback. Do not remove.
        _pc.OnVideoFormatsNegotiated += (formats) =>
        {
            if (formats == null || formats.Count == 0) return;
            try
            {
                var fmt = formats[0];
                if (fmt.Codec != VideoCodecsEnum.VP8)
                {
                    Log.Warn($"webrtc rejected negotiated codec {fmt.Codec}; VP8 required");
                    return;
                }
                _videoEnd?.SetVideoSourceFormat(fmt);
                _formatReady = true;
                _negotiatedPt = fmt.FormatID;
                Log.Info($"[t={MonoClock.ElapsedMilliseconds}] webrtc video format negotiated: {fmt.Codec} pt={fmt.FormatID}");
            }
            catch (Exception ex) { Log.Warn($"webrtc set format: {ex.Message}"); }
        };


        _pc.ondatachannel += (dc) =>
        {
            Log.Info($"webrtc dc open: {dc.label}");
            // Ingress coalescer: consecutive `mousemove` messages collapse to
            // the latest before hitting the input pump. Any other kind (click,
            // key, wheel, text, curtain_*) flushes the pending move first to
            // preserve ordering with click landing sites.
            JsonElement? pendingMove = null;
            var moveLock = new object();
            dc.onmessage += (_, __, data) =>
            {
                try
                {
                    var json = System.Text.Encoding.UTF8.GetString(data);
                    var doc = JsonDocument.Parse(json);
                    var root = doc.RootElement;
                    var kind = root.TryGetProperty("kind", out var kv) ? kv.GetString() : null;
                    if (kind == "mousemove")
                    {
                        lock (moveLock) { pendingMove = root.Clone(); }
                        doc.Dispose();
                        return;
                    }
                    JsonElement? flush;
                    lock (moveLock) { flush = pendingMove; pendingMove = null; }
                    if (flush.HasValue) InputRelayBridge.Apply(flush.Value);
                    InputRelayBridge.Apply(root);
                    doc.Dispose();
                }
                catch (Exception ex) { Log.Warn($"webrtc dc apply: {ex.Message}"); }
            };
        };


        _pc.onicecandidate += async (c) =>
        {
            if (c == null) return;
            try
            {
                var payload = new
                {
                    candidate = c.candidate,
                    sdpMid = c.sdpMid,
                    sdpMLineIndex = c.sdpMLineIndex,
                };
                await _api.PostSignalReliableAsync(_sessionId, "ice", payload, _cts.Token, _currentAdminClientId);
            }
            catch (Exception ex) { Log.Warn($"webrtc ice post: {ex.Message}"); }
        };

        _pc.onconnectionstatechange += async (s) =>
        {
            Log.Info($"webrtc pc state: {s}");
            if (s == RTCPeerConnectionState.connected)
            {
                // The encoder is a source: it stays paused until StartVideo().
                try
                {
                    if (_videoEnd != null && !_videoStarted)
                    {
                        await _videoEnd.StartVideo();
                        _videoStarted = true;
                        try { _videoEnd.ForceKeyFrame(); } catch { }
                        ScreenCapture.ResetWebRtcTee();
                        Log.Info("webrtc video source started (keyframe forced)");
                    }
                }
                catch (Exception ex) { Log.Warn($"webrtc start video: {ex.Message}"); }
                return;
            }
            if (s == RTCPeerConnectionState.failed || s == RTCPeerConnectionState.closed || s == RTCPeerConnectionState.disconnected)
            {
                // Only the peer is torn down here; a follow-up offer (same or
                // different admin) can rebuild it. HTTPS stream is unaffected.
                TearDownPeer();
            }
        };
    }

    private void TearDownPeer()
    {
        try { _videoEnd?.PauseVideo(); } catch { }
        try { _videoEnd?.CloseVideo(); } catch { }
        try { _pc?.close(); } catch { }
        _videoEnd = null;
        _pc = null;
        _formatReady = false;
        _videoStarted = false;
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
        if (width < 2 || height < 2 || (width & 1) != 0 || (height & 1) != 0 ||
            bgra.Length != checked(width * height * 4))
        {
            Interlocked.Increment(ref _dropped);
            Log.Warn($"webrtc rejected malformed raw frame {width}x{height}, bytes={bgra.Length}");
            return;
        }
        var pc = _pc;
        var enc = _videoEnd;
        if (enc == null || pc == null) { Interlocked.Increment(ref _dropped); return; }
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
            enc.ExternalVideoSourceRawSample(
                33, width, height, bgra, VideoPixelFormatsEnum.Bgra);

        }
        catch (Exception ex) { Log.Warn($"webrtc encode: {ex.Message}"); }
        MaybeLogStats();
    }

    /// <summary>~5 s heartbeat of the video pipeline so "connected but black" is diagnosable.</summary>
    private void MaybeLogStats()
    {
        var now = DateTime.UtcNow;
        if ((now - _lastStatsUtc).TotalSeconds < 5) return;
        _lastStatsUtc = now;
        Log.Info($"webrtc video pipe: pushed={Interlocked.Read(ref _pushed)} " +
                 $"encoded={Interlocked.Read(ref _encoded)} dropped={Interlocked.Read(ref _dropped)} " +
                 $"formatReady={_formatReady} started={_videoStarted}");
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
        var kind = it.GetProperty("kind").GetString();
        var payload = it.GetProperty("payload");
        string? incomingAdminId = null;
        if (it.TryGetProperty("admin_client_id", out var acid) && acid.ValueKind == JsonValueKind.String)
            incomingAdminId = acid.GetString();

        switch (kind)
        {
            case "offer":
            {
                await _handoffLock.WaitAsync(_cts.Token);
                try
                {
                    // Take-over: a *different* admin machine is offering while we
                    // already have a peer. Tell the old admin its session was
                    // superseded, then rebuild the peer for the new one.
                    if (_pc != null &&
                        !string.IsNullOrEmpty(_currentAdminClientId) &&
                        !string.IsNullOrEmpty(incomingAdminId) &&
                        !string.Equals(_currentAdminClientId, incomingAdminId, StringComparison.Ordinal))
                    {
                        Log.Info($"webrtc takeover: {_currentAdminClientId} -> {incomingAdminId}");
                        try
                        {
                            await _api.PostSignalReliableAsync(
                                _sessionId, "terminated",
                                new { reason = "superseded_by_other_client" },
                                _cts.Token,
                                _currentAdminClientId);
                        }
                        catch { /* best-effort */ }
                        try { await Task.Delay(50, _cts.Token); } catch { }
                        TearDownPeer();
                    }

                    _currentAdminClientId = incomingAdminId;
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
                        new { type = "answer", sdp = answer.sdp }, _cts.Token, _currentAdminClientId);
                }
                finally { _handoffLock.Release(); }
                break;
            }
            case "ice":
            {
                if (_pc == null) return;
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
                // Only honor bye from the currently-owning admin, otherwise a
                // late packet from a superseded admin could kill the live session.
                if (string.IsNullOrEmpty(_currentAdminClientId) ||
                    string.IsNullOrEmpty(incomingAdminId) ||
                    string.Equals(_currentAdminClientId, incomingAdminId, StringComparison.Ordinal))
                {
                    Close();
                }
                break;
        }
    }

    public void Close()
    {
        if (_closed) return;
        _closed = true;
        if (Current == this) Current = null;
        try { _cts.Cancel(); } catch { }
        TearDownPeer();
    }

    public void Dispose() => Close();
}

/// <summary>
/// Reuses InputRelay's `Apply(JsonElement)` switch without exposing it publicly.
/// Wired via reflection to avoid touching InputRelay signatures.
/// </summary>
internal static class InputRelayBridge
{
    private static readonly System.Reflection.MethodInfo? _apply =
        typeof(InputRelay).GetMethod("Apply",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);

    public static void Apply(JsonElement el)
    {
        _apply?.Invoke(null, new object[] { el });
    }
}
