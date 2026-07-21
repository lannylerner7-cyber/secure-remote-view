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

    public WebRtcSession(ApiClient api, string sessionId)
    {
        _api = api;
        _sessionId = sessionId;
        _cts = new CancellationTokenSource();
        Current = this;
    }

    public async Task StartAsync()
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
        MediaStreamTrack videoTrack = new(_videoEnd.GetVideoSourceFormats(), MediaStreamStatusEnum.SendOnly);
        _pc.addTrack(videoTrack);
        _videoEnd.OnVideoSourceEncodedSample += (durationRtpUnits, sample) =>
        {
            _pc?.SendVideo(durationRtpUnits, sample);
        };

        _pc.OnDataChannelOpened += (label) => Log.Info($"webrtc dc open: {label}");
        _pc.ondatachannel += (dc) =>
        {
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
                await _api.PostSignalAsync(_sessionId, "ice", payload, _cts.Token);
            }
            catch (Exception ex) { Log.Warn($"webrtc ice post: {ex.Message}"); }
        };

        _pc.onconnectionstatechange += (s) =>
        {
            Log.Info($"webrtc pc state: {s}");
            if (s == RTCPeerConnectionState.failed || s == RTCPeerConnectionState.closed || s == RTCPeerConnectionState.disconnected)
            {
                // HTTPS stream keeps flowing; just tear the peer down.
                Close();
            }
        };

        // Poll admin signals — the admin publishes offer/ice via the same table.
        _ = SignalPumpAsync(_cts.Token);
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
        if (_pc == null) return;
        var kind = it.GetProperty("kind").GetString();
        var payload = it.GetProperty("payload");
        switch (kind)
        {
            case "offer":
            {
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
                    new { type = "answer", sdp = answer.sdp }, _cts.Token);
                break;
            }
            case "ice":
            {
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
                Close();
                break;
        }
    }

    public void Close()
    {
        if (_closed) return;
        _closed = true;
        try { _cts.Cancel(); } catch { }
        try { _videoEnd?.CloseVideo(); } catch { }
        try { _pc?.close(); } catch { }
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
