using System;
using System.Diagnostics;
using System.Threading;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:CAPTURE — S17 step 1 measurement.
///
/// PROJECT-MAP.md §10.6 makes hardware H.264 (step 2) conditional on evidence
/// from a real session rather than on impressions. Four numbers decide it:
///
///   1. the geometry actually handed to an encoder (proves the 1:1 passthrough
///      and the unclamped virtual-screen bounds from step 1 are live);
///   2. how long the encode itself takes, per transport;
///   3. what fraction of a core the agent process burns while doing it;
///   4. whether a hardware encoder existed on that machine anyway.
///
/// (1) and (4) were already reported by the heartbeat. This class owns (2) and
/// (3) and does nothing else — it never changes a codec, a rung, or a cadence.
/// It is a measuring instrument, so it is deliberately cheap: two interlocked
/// adds per frame, and one <see cref="Process.TotalProcessorTime"/> read per
/// sample window.
///
/// A failed CPU/working-set read reports "not measured" instead of throwing: a
/// missing diagnostic must never take capture down.
/// </summary>
public static class EncodeStats
{
    /// <summary>Shortest window, in ms, between two CPU samples. Below this the delta is noise.</summary>
    private const int CpuSampleWindowMs = 2000;

    private static readonly Stopwatch _clock = Stopwatch.StartNew();
    private static readonly object _cpuGate = new();

    // ---- encode timing, per transport -------------------------------------
    private static long _jpegFrames, _jpegMicros;
    private static long _vp8Frames, _vp8Micros;

    // Widest geometry seen this session — the honest answer to "did we really
    // capture at native resolution?" even if the ladder stepped down later.
    private static int _peakWidth, _peakHeight;
    private static int _lastWidth, _lastHeight;

    // ---- CPU sampling ------------------------------------------------------
    private static TimeSpan _lastCpuTotal = TimeSpan.Zero;
    private static long _lastCpuSampleMs = -1;
    private static double _cpuPercent = -1;

    /// <summary>
    /// Record one JPEG (HTTPS fallback transport) encode. <paramref name="micros"/>
    /// is the encode alone — never the upload, which the ladder already owns
    /// through <see cref="BitrateController.NoteUploadLatency"/>. Mixing the two
    /// would make a slow link look like a slow encoder, which is precisely the
    /// confusion S17 has to avoid.
    /// </summary>
    public static void NoteJpegEncode(long micros, int width, int height)
    {
        Interlocked.Increment(ref _jpegFrames);
        Interlocked.Add(ref _jpegMicros, micros < 0 ? 0 : micros);
        NoteGeometry(width, height);
    }

    /// <summary>Record one software VP8 (WebRTC transport) encode submission.</summary>
    public static void NoteVp8Encode(long micros, int width, int height)
    {
        Interlocked.Increment(ref _vp8Frames);
        Interlocked.Add(ref _vp8Micros, micros < 0 ? 0 : micros);
        NoteGeometry(width, height);
    }

    private static void NoteGeometry(int width, int height)
    {
        if (width <= 0 || height <= 0) return;
        _lastWidth = width;
        _lastHeight = height;
        // Not interlocked: a torn read costs one wrong digit in a diagnostic,
        // and taking a lock on every frame to protect a log line is the wrong
        // trade on the hot path.
        if ((long)width * height > (long)_peakWidth * _peakHeight)
        {
            _peakWidth = width;
            _peakHeight = height;
        }
    }

    /// <summary>Mean JPEG encode time in ms this session, or -1 with no samples.</summary>
    public static double JpegEncodeMs => Mean(Interlocked.Read(ref _jpegFrames), Interlocked.Read(ref _jpegMicros));

    /// <summary>Mean software VP8 encode time in ms this session, or -1 with no samples.</summary>
    public static double Vp8EncodeMs => Mean(Interlocked.Read(ref _vp8Frames), Interlocked.Read(ref _vp8Micros));

    /// <summary>Largest frame geometry handed to an encoder this session.</summary>
    public static (int Width, int Height) PeakGeometry => (_peakWidth, _peakHeight);

    /// <summary>Most recent frame geometry handed to an encoder.</summary>
    public static (int Width, int Height) LastGeometry => (_lastWidth, _lastHeight);

    private static double Mean(long frames, long micros) => frames <= 0 ? -1 : micros / 1000.0 / frames;

    /// <summary>
    /// Agent process CPU as a percentage of ONE core, so a value above 100 on a
    /// multi-core box is real and meaningful: it means the encode is spilling
    /// across threads. Returns -1 until two samples exist, or when the host
    /// refuses the read. Cached for <see cref="CpuSampleWindowMs"/>, so calling
    /// this per heartbeat and per log line costs one read.
    /// </summary>
    public static double CpuPercentOfCore()
    {
        lock (_cpuGate)
        {
            long now = _clock.ElapsedMilliseconds;
            if (_lastCpuSampleMs >= 0 && now - _lastCpuSampleMs < CpuSampleWindowMs) return _cpuPercent;

            try
            {
                var total = Process.GetCurrentProcess().TotalProcessorTime;
                if (_lastCpuSampleMs >= 0)
                {
                    double wallMs = now - _lastCpuSampleMs;
                    double cpuMs = (total - _lastCpuTotal).TotalMilliseconds;
                    if (wallMs > 0) _cpuPercent = Math.Max(0, cpuMs * 100.0 / wallMs);
                }
                _lastCpuTotal = total;
                _lastCpuSampleMs = now;
            }
            catch
            {
                _cpuPercent = -1;
                _lastCpuSampleMs = now;
            }
            return _cpuPercent;
        }
    }

    /// <summary>Working set in MB, or -1 when the host refuses the read.</summary>
    public static long WorkingSetMb()
    {
        try { return Process.GetCurrentProcess().WorkingSet64 / (1024 * 1024); }
        catch { return -1; }
    }

    /// <summary>
    /// One line for the agent log. Read alongside the admin's per-minute
    /// <c>[video]</c> line from <c>VideoPipeline.StatsLine()</c>: together they
    /// are the whole encode-to-present picture for the S17 decision.
    /// </summary>
    public static string Line()
    {
        double cpu = CpuPercentOfCore();
        var (pw, ph) = PeakGeometry;
        var (lw, lh) = LastGeometry;
        string jpeg = JpegEncodeMs < 0 ? "-" : $"{JpegEncodeMs:F1}ms";
        string vp8 = Vp8EncodeMs < 0 ? "-" : $"{Vp8EncodeMs:F1}ms";
        long ws = WorkingSetMb();
        return $"[encode] wire={CodecPolicy.WireCodecTag} " +
               $"rung={BitrateController.RungIndex}/{BitrateController.Rungs - 1} " +
               $"size={lw}x{lh} peak={pw}x{ph} jpeg={jpeg} vp8={vp8} " +
               $"cpu={(cpu < 0 ? "-" : cpu.ToString("F0") + "%")} " +
               $"ws={(ws < 0 ? "-" : ws + "MB")} hw={SafeVendorTag()}";
    }

    private static string SafeVendorTag()
    {
        try { return HwEncoderProbe.VendorTag; }
        catch { return "unknown"; }
    }

    /// <summary>
    /// Compact object for the heartbeat, so the fleet-wide answer lands in
    /// <c>devices.metadata.encode</c> without a new table. Nulls rather than
    /// sentinel numbers, so "not measured" stays distinguishable from "zero".
    /// </summary>
    public static object HeartbeatPayload()
    {
        double cpu = CpuPercentOfCore();
        double jpeg = JpegEncodeMs;
        double vp8 = Vp8EncodeMs;
        long ws = WorkingSetMb();
        var (pw, ph) = PeakGeometry;
        return new
        {
            jpeg_ms = jpeg < 0 ? (double?)null : Math.Round(jpeg, 2),
            vp8_ms = vp8 < 0 ? (double?)null : Math.Round(vp8, 2),
            cpu_pct = cpu < 0 ? (double?)null : Math.Round(cpu, 1),
            ws_mb = ws < 0 ? (long?)null : ws,
            peak_width = pw,
            peak_height = ph,
            rung = BitrateController.RungIndex,
        };
    }

    /// <summary>
    /// New session: the previous session's averages say nothing about this one.
    /// Peak geometry resets too — it is a per-session claim about what this link
    /// actually carried, not a standing machine capability.
    /// </summary>
    public static void Reset()
    {
        Interlocked.Exchange(ref _jpegFrames, 0);
        Interlocked.Exchange(ref _jpegMicros, 0);
        Interlocked.Exchange(ref _vp8Frames, 0);
        Interlocked.Exchange(ref _vp8Micros, 0);
        _peakWidth = _peakHeight = 0;
        _lastWidth = _lastHeight = 0;
    }
}
