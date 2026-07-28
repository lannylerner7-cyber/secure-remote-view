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
        var cfg = new RTCConfiguration
        {
            iceServers = new List<RTCIceServer>
            {
                new RTCIceServer { urls = "stun:stun.l.google.com:19302" },
            },
        };
        _pc = new RTCPeerConnection(cfg);

        _videoEnd = new VideoEncoderEndPoint();
        // Codec pinning guardrail — MUST stay in lockstep with admin/src/Media/WebRtcClient.cs.
        try { _videoEnd.RestrictFormats(f => f.Codec == VideoCodecsEnum.VP8); } catch { }
        MediaStreamTrack videoTrack = new(_videoEnd.GetVideoSourceFormats(), MediaStreamStatusEnum.SendOnly);
        _pc.addTrack(videoTrack);

        _videoEnd.OnVideoSourceEncodedSample += (durationRtpUnits, sample) =>
        {
            _pc?.SendVideo(durationRtpUnits, sample);
        };

        _pc.ondatachannel += (dc) =>
        {
            Log.Info($"webrtc dc open: {dc.label}");
            dc.onmessage += (_, __, data) =>
            {
                try
                {
                    var json = System.Text.Encoding.UTF8.GetString(data);
                    using var doc = JsonDocument.Parse(json);
                    InputRelayBridge.Apply(doc.RootElement);
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
                await _api.PostSignalAsync(_sessionId, "ice", payload, _cts.Token, _currentAdminClientId);
            }
            catch (Exception ex) { Log.Warn($"webrtc ice post: {ex.Message}"); }
        };

        _pc.onconnectionstatechange += (s) =>
        {
            Log.Info($"webrtc pc state: {s}");
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
        try { _videoEnd?.CloseVideo(); } catch { }
        try { _pc?.close(); } catch { }
        _videoEnd = null;
        _pc = null;
    }

    /// <summary>
    /// Called from ScreenCapture: encode this frame into the WebRTC video track.
    /// Silently no-op when the peer isn't connected yet — admin sees the HTTPS
    /// stream in that window.
    /// </summary>
    public void PushFrame(byte[] bgra, int width, int height, int stride)
    {
        if (_videoEnd == null || _pc == null) return;
        if (_pc.connectionState != RTCPeerConnectionState.connected) return;
        try
        {
            _videoEnd.ExternalVideoSourceRawSample(
                33, width, height, bgra, VideoPixelFormatsEnum.Bgra);
        }
        catch (Exception ex) { Log.Warn($"webrtc encode: {ex.Message}"); }
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
                            await _api.PostSignalAsync(
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
                    await _api.PostSignalAsync(_sessionId, "answer",
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
