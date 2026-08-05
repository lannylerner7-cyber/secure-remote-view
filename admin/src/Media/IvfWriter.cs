using System;
using System.IO;
using System.Text;
using ConnectLive.Admin.Diag;

namespace ConnectLive.Admin.Media;

/// <summary>
/// S24 — session recording for the native console.
///
/// The web console records with MediaRecorder, which the native client has no
/// equivalent for. Instead we tee the already-depacketised VP8 frames straight
/// to disk in IVF, the canonical raw-VP8 container: a 32-byte file header plus
/// a 12-byte header per frame. That is zero re-encode, zero extra bandwidth and
/// no extra work for the agent — the exact bytes we decode are the bytes we
/// store.
///
/// The result plays in VLC/mpv directly and converts losslessly:
///     ffmpeg -i session.ivf -c copy session.webm
///
/// The frame count in the file header is only known once recording stops, so
/// Stop() seeks back and patches it. A recording that is never stopped cleanly
/// still plays — most decoders ignore the count — which is why the writer
/// flushes after every frame.
/// </summary>
public sealed class IvfWriter : IDisposable
{
    private const int FileHeaderBytes = 32;

    private readonly object _gate = new();
    private FileStream? _fs;
    private uint _frames;
    private readonly DateTime _startedUtc = DateTime.UtcNow;
    private long _firstTicks = -1;

    public string Path { get; }
    public int Width { get; }
    public int Height { get; }
    public uint FrameCount { get { lock (_gate) return _frames; } }
    public TimeSpan Duration => DateTime.UtcNow - _startedUtc;

    /// <param name="path">Destination .ivf file; the directory is created if missing.</param>
    /// <param name="width">Stream width in pixels (header only; decoders trust the bitstream).</param>
    /// <param name="height">Stream height in pixels.</param>
    public IvfWriter(string path, int width, int height)
    {
        Path = path;
        // IVF stores 16-bit dimensions; clamp so a bogus value cannot corrupt
        // the header. 0 is legal and tells the player to trust the bitstream.
        Width = Math.Clamp(width, 0, ushort.MaxValue);
        Height = Math.Clamp(height, 0, ushort.MaxValue);

        var dir = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        _fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        WriteFileHeader();
    }

    private void WriteFileHeader()
    {
        var h = new byte[FileHeaderBytes];
        Encoding.ASCII.GetBytes("DKIF").CopyTo(h, 0);       // signature
        WriteU16(h, 4, 0);                                   // version
        WriteU16(h, 6, FileHeaderBytes);                     // header length
        Encoding.ASCII.GetBytes("VP80").CopyTo(h, 8);        // FourCC — VP8
        WriteU16(h, 12, (ushort)Width);
        WriteU16(h, 14, (ushort)Height);
        WriteU32(h, 16, 1000);                               // time base denominator
        WriteU32(h, 20, 1);                                  // time base numerator → ms timestamps
        WriteU32(h, 24, 0);                                  // frame count, patched on Stop()
        WriteU32(h, 28, 0);                                  // unused
        _fs!.Write(h, 0, h.Length);
        _fs.Flush();
    }

    /// <summary>Append one whole VP8 frame. Timestamps are milliseconds since the first frame.</summary>
    public void WriteFrame(byte[] frame)
    {
        if (frame == null || frame.Length == 0) return;
        lock (_gate)
        {
            if (_fs == null) return;
            var nowTicks = DateTime.UtcNow.Ticks;
            if (_firstTicks < 0) _firstTicks = nowTicks;
            var ms = (ulong)((nowTicks - _firstTicks) / TimeSpan.TicksPerMillisecond);

            var hdr = new byte[12];
            WriteU32(hdr, 0, (uint)frame.Length);
            WriteU64(hdr, 4, ms);
            try
            {
                _fs.Write(hdr, 0, hdr.Length);
                _fs.Write(frame, 0, frame.Length);
                _fs.Flush();
                _frames++;
            }
            catch (Exception ex)
            {
                Log.Warn("[record] frame write failed, stopping: " + ex.Message);
                CloseLocked(patchCount: false);
            }
        }
    }

    /// <summary>Finish the file and patch the frame count. Returns the written path.</summary>
    public string Stop()
    {
        lock (_gate)
        {
            CloseLocked(patchCount: true);
            return Path;
        }
    }

    private void CloseLocked(bool patchCount)
    {
        var fs = _fs;
        if (fs == null) return;
        _fs = null;
        try
        {
            if (patchCount)
            {
                var count = new byte[4];
                WriteU32(count, 0, _frames);
                fs.Seek(24, SeekOrigin.Begin);
                fs.Write(count, 0, count.Length);
            }
            fs.Flush();
        }
        catch (Exception ex) { Log.Warn("[record] finalise failed: " + ex.Message); }
        finally { try { fs.Dispose(); } catch { } }
    }

    public void Dispose() { lock (_gate) CloseLocked(patchCount: true); }

    private static void WriteU16(byte[] b, int o, ushort v)
    {
        b[o] = (byte)(v & 0xFF); b[o + 1] = (byte)(v >> 8);
    }

    private static void WriteU32(byte[] b, int o, uint v)
    {
        b[o] = (byte)(v & 0xFF); b[o + 1] = (byte)((v >> 8) & 0xFF);
        b[o + 2] = (byte)((v >> 16) & 0xFF); b[o + 3] = (byte)((v >> 24) & 0xFF);
    }

    private static void WriteU64(byte[] b, int o, ulong v)
    {
        for (int i = 0; i < 8; i++) b[o + i] = (byte)((v >> (8 * i)) & 0xFF);
    }
}
