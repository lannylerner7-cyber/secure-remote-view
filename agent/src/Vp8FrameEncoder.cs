using System;
using SIPSorceryMedia.Abstractions;
using SIPSorceryMedia.Encoders;

namespace ConnectLive.Agent;

/// <summary>
/// Tests the actual encoder, not VideoEncoderEndPoint's advertised-format list.
/// Recreates libvpx on geometry changes; its encoder is initialized for one size.
/// </summary>
internal sealed class Vp8FrameEncoder : IDisposable
{
    private readonly object _gate = new();
    private VpxVideoEncoder? _encoder;
    private int _width, _height;
    private bool _closed;

    internal static Vp8FrameEncoder? TryCreate()
    {
        // Read-only diagnostics are not a codec gate: a custom loader may work
        // even if the bounded inventory did not find its candidate.
        Vp8NativeDiagnostics.LogOnce();
        var result = new Vp8FrameEncoder();
        try
        {
            // Synthetic pixels only: exercise native-library load and encode.
            var probe = result.Encode(new byte[16 * 16 * 4], 16, 16);
            if (probe is { Length: > 0 })
            {
                Log.Info("VP8 synthetic encode passed (16x16); live geometry, negotiation and delivery remain unverified");
                return result;
            }
            Log.Warn("VP8 unavailable: synthetic probe produced no encoded frame; no missing dependency established");
        }
        catch (Exception ex) { Log.Warn($"VP8 encoder probe failed: {Vp8NativeDiagnostics.ExplainProbeFailure(ex)}"); }
        result.Dispose();
        return null;
    }

    internal byte[]? Encode(byte[] rgba, int width, int height)
    {
        lock (_gate)
        {
            if (_closed) return null;
            if (_encoder == null || width != _width || height != _height)
            {
                ReleaseEncoder();
                _encoder = new VpxVideoEncoder();
                _width = width;
                _height = height;
                _encoder.ForceKeyFrame();
            }
            // This package's Bgra converter consumes the existing capture RGBA contract.
            return _encoder.EncodeVideo(width, height, rgba, VideoPixelFormatsEnum.Bgra, VideoCodecsEnum.VP8);
        }
    }

    internal void ForceKeyFrame() { lock (_gate) { if (!_closed) _encoder?.ForceKeyFrame(); } }
    // A failed native initialization can leave a managed encoder whose Dispose
    // calls the same unavailable DLL. Cleanup must not escape the probe and
    // prevent an independent H.264 candidate from being offered.
    // Caller holds _gate. Detach first so a failed disposal is never retried.
    private void ReleaseEncoder()
    {
        var encoder = _encoder;
        _encoder = null;
        _width = _height = 0;
        if (encoder == null) return;
        try { encoder.Dispose(); }
        catch (Exception ex)
        {
            Log.Warn($"VP8 encoder cleanup failed; encoder discarded: {ex.GetType().Name} hresult=0x{ex.HResult:X8}; " +
                "cleanup does not repair native dependencies or change H.264 eligibility");
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _closed = true;
            ReleaseEncoder();
        }
    }
}
