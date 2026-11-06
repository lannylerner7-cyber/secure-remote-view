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
        var result = new Vp8FrameEncoder();
        try
        {
            // Synthetic pixels only: exercise native-library load and encode.
            var probe = result.Encode(new byte[16 * 16 * 4], 16, 16);
            if (probe is { Length: > 0 }) return result;
            Log.Warn("VP8 probe produced no encoded frame");
        }
        catch (Exception ex) { Log.Warn($"VP8 encoder probe failed: {ex.GetType().Name}"); }
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
                _encoder?.Dispose();
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
    public void Dispose()
    {
        lock (_gate)
        {
            _closed = true;
            _encoder?.Dispose();
            _encoder = null;
        }
    }
}
