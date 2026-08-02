using System;
using System.IO;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Gate B / restoration G6 — passive RTP capture harness.
///
/// Debug-flag gated: does nothing unless the environment variable
/// <c>CONNECTLIVE_RTP_CAPTURE=1</c> is set. When enabled, every inbound video
/// RTP packet is appended to
/// <c>%LOCALAPPDATA%\ConnectLive\spikes\vp8-decode\capture.rtpdump</c> as
///
///     [int64 arrivalUnixMs][int32 length][length bytes]
///
/// The tap is strictly passive — it never mutates or delays the packet, so the
/// JPEG fallback stays on screen while the operator records a burst on a live
/// session. Spike 1 then replays the file fully offline.
///
/// Operator:
///   setx CONNECTLIVE_RTP_CAPTURE 1
///   (start a session, hold ~10s of motion, end the session)
///   the file path is printed to the debug log on first packet.
///
/// This tap is deleted after Phase 3, per the contract.
/// </summary>
public sealed class RtpCapture : IDisposable
{
    public static bool Enabled =>
        string.Equals(Environment.GetEnvironmentVariable("CONNECTLIVE_RTP_CAPTURE"), "1",
            StringComparison.Ordinal);

    private readonly object _gate = new();
    private FileStream? _fs;
    private BinaryWriter? _bw;
    private long _packets;
    private bool _disposed;

    public string? Path { get; private set; }

    public static RtpCapture? CreateIfEnabled(string sessionId)
    {
        if (!Enabled) return null;
        try { return new RtpCapture(sessionId); }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine("[rtpcap] disabled — " + ex.Message);
            return null;
        }
    }

    private RtpCapture(string sessionId)
    {
        var dir = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ConnectLive", "spikes", "vp8-decode");
        Directory.CreateDirectory(dir);
        Path = System.IO.Path.Combine(dir, "capture.rtpdump");
        _fs = new FileStream(Path, FileMode.Create, FileAccess.Write, FileShare.Read, 64 * 1024);
        _bw = new BinaryWriter(_fs);
        System.Diagnostics.Debug.WriteLine($"[rtpcap] recording session {sessionId} -> {Path}");
    }

    /// <summary>Append one packet. Never throws; a broken tap must not kill the session.</summary>
    public void Write(byte[] packet)
    {
        if (packet == null || packet.Length == 0) return;
        lock (_gate)
        {
            if (_disposed || _bw == null) return;
            try
            {
                _bw.Write(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                _bw.Write(packet.Length);
                _bw.Write(packet);
                _packets++;
                if (_packets % 500 == 0) _bw.Flush();
            }
            catch { /* passive tap: swallow */ }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            try { _bw?.Flush(); } catch { }
            try { _bw?.Dispose(); } catch { }
            try { _fs?.Dispose(); } catch { }
            _bw = null; _fs = null;
            System.Diagnostics.Debug.WriteLine($"[rtpcap] closed, packets={_packets}, path={Path}");
        }
    }
}
