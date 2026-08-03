using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using SIPSorceryMedia.Abstractions;
using SIPSorceryMedia.Encoders;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Phases 1–3 — the native video pipeline.
///
///   RTP (depacketised by SIPSorcery) → bounded drop-oldest queue
///     → VP8 decode on a dedicated worker thread (never the UI thread)
///     → I420/BGR → BGRA32 via <see cref="FrameConvert"/> (Spike 1 code, verbatim)
///     → present: D3DImage when the D3D path is healthy, WriteableBitmap otherwise
///
/// Design rules taken straight from the contract:
///   * decode OFF the UI thread, present ON it;
///   * the queue drops the OLDEST frame under pressure — a live view must show
///     "now", not a backlog;
///   * a decode stall or a gap in frames asks for a keyframe FIRST
///     (<see cref="KeyFrameRequested"/>); the ICE restart is the caller's
///     second-line remedy;
///   * a mid-session resolution change resizes buffers in place — no teardown;
///   * G2 measurement is built in: fps, queue depth, decode-to-present latency.
/// </summary>
public sealed class VideoPipeline : IDisposable
{
    private const int MaxQueue = 3;               // ~3-frame jitter buffer
    private const int StallMs = 1500;             // no decoded frame for this long → ask for a keyframe

    private readonly Queue<(byte[] data, long enqueuedMs)> _queue = new();
    private readonly object _qGate = new();
    private readonly SemaphoreSlim _signal = new(0);
    private readonly CancellationTokenSource _cts = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly D3DImageHost _d3d = new();

    private Thread? _worker;
    private VideoEncoder? _decoder;
    private byte[]? _bgra;
    private int _width, _height;
    private WriteableBitmap? _bitmap;
    private volatile bool _disposed;

    // ---- G2 counters -----------------------------------------------------
    private long _framesIn, _framesDecoded, _framesDropped, _framesPresented, _decodeErrors;
    private long _lastDecodedMs = -1;
    private double _fps;
    private double _lastLatencyMs;
    private long _fpsWindowStart;
    private long _fpsWindowFrames;

    public long FramesDecoded => Interlocked.Read(ref _framesDecoded);
    public long FramesDropped => Interlocked.Read(ref _framesDropped);
    public long FramesPresented => Interlocked.Read(ref _framesPresented);
    public double Fps => _fps;
    public double LastLatencyMs => _lastLatencyMs;
    public int QueueDepth { get { lock (_qGate) return _queue.Count; } }
    public int SourceWidth => _width;
    public int SourceHeight => _height;

    /// <summary>True only while decoded frames are actually reaching the screen (Phase 6 pill honesty).</summary>
    public bool IsPresenting =>
        _lastDecodedMs >= 0 && (_clock.ElapsedMilliseconds - Interlocked.Read(ref _lastDecodedMs)) < 2000;

    /// <summary>True when the D3D present path is live; false means the WriteableBitmap fallback.</summary>
    public bool UsingD3D { get; private set; }

    /// <summary>Raised (worker thread) when the pipeline wants a fresh keyframe from the agent.</summary>
    public event Action? KeyFrameRequested;

    /// <summary>Raised on the UI thread the first time a presentable surface exists, and on resize.</summary>
    public event Action<ImageSource>? SurfaceReady;

    /// <summary>Raised on the UI thread the first time a decoded frame is presented.</summary>
    public event Action? FirstFrame;

    /// <summary>Raised (worker thread) with a one-line human-readable problem description.</summary>
    public event Action<string>? Diagnostic;

    public void Start()
    {
        if (_worker != null) return;
        _worker = new Thread(DecodeLoop)
        {
            IsBackground = true,
            Name = "connectlive-vp8-decode",
            Priority = ThreadPriority.AboveNormal,
        };
        _worker.Start();
        StartStallWatch();
    }

    /// <summary>
    /// S13 — RTP loss/reorder was reported upstream. SIPSorcery reassembles VP8
    /// frames for us but happily hands over a frame whose packets were lost, and
    /// feeding that to the decoder is exactly how the stripe corruption appears:
    /// every later inter frame references a reference buffer that never existed.
    /// So we gate: nothing decodes until the next keyframe lands, and we ask for
    /// one immediately.
    /// </summary>
    public void NotifyPacketLoss(int missing)
    {
        if (_disposed) return;
        Interlocked.Increment(ref _lossEvents);
        if (!_awaitingKeyFrame)
        {
            _awaitingKeyFrame = true;
            Diagnostic?.Invoke($"packet loss ({missing} rtp seq missing) — gating decode until the next keyframe");
        }
        lock (_qGate)
        {
            while (_queue.Count > 0) { _queue.Dequeue(); Interlocked.Increment(ref _framesDropped); }
        }
        try { KeyFrameRequested?.Invoke(); } catch { }
    }

    /// <summary>
    /// VP8 uncompressed data chunk, first byte: bit 0 is the inverse keyframe
    /// flag (0 = keyframe). RFC 6386 §9.1.
    /// </summary>
    private static bool IsKeyFrame(byte[] f) => f.Length > 0 && (f[0] & 0x01) == 0;

    /// <summary>Submit one depacketised VP8 frame. Never blocks the RTP thread.</summary>
    public void Submit(byte[] encodedFrame)
    {
        if (_disposed || encodedFrame == null || encodedFrame.Length == 0) return;
        Interlocked.Increment(ref _framesIn);

        if (_awaitingKeyFrame)
        {
            if (!IsKeyFrame(encodedFrame))
            {
                Interlocked.Increment(ref _framesGated);
                return;
            }
            _awaitingKeyFrame = false;
            Diagnostic?.Invoke("keyframe recovered — decode resumed");
        }

        lock (_qGate)
        {
            while (_queue.Count >= MaxQueue)
            {
                _queue.Dequeue();
                Interlocked.Increment(ref _framesDropped);
            }
            _queue.Enqueue((encodedFrame, _clock.ElapsedMilliseconds));
        }
        try { _signal.Release(); } catch { }
    }


    private void DecodeLoop()
    {
        try { _decoder = new VideoEncoder(); }
        catch (Exception ex)
        {
            Diagnostic?.Invoke("VP8 decoder unavailable: " + ex.Message);
            return;
        }

        var ct = _cts.Token;
        while (!ct.IsCancellationRequested)
        {
            try { _signal.Wait(ct); } catch { return; }
            (byte[] data, long enqueuedMs) item;
            lock (_qGate)
            {
                if (_queue.Count == 0) continue;
                item = _queue.Dequeue();
            }
            DecodeOne(item.data, item.enqueuedMs);
        }
    }

    private void DecodeOne(byte[] encoded, long enqueuedMs)
    {
        IEnumerable<VideoSample>? samples;
        try
        {
            samples = _decoder!.DecodeVideo(encoded, VideoPixelFormatsEnum.Bgra, VideoCodecsEnum.VP8);
        }
        catch (Exception ex)
        {
            if (Interlocked.Increment(ref _decodeErrors) % 30 == 1)
                Diagnostic?.Invoke("VP8 decode error: " + ex.Message);
            KeyFrameRequested?.Invoke();
            return;
        }
        if (samples == null) return;

        foreach (var s in samples)
        {
            int w = (int)s.Width, h = (int)s.Height;
            if (w <= 0 || h <= 0 || s.Sample == null) continue;

            EnsureBuffers(w, h);
            if (_bgra == null) continue;

            if (!FrameConvert.ToBgra32(s.Sample, w, h, _bgra))
            {
                if (Interlocked.Increment(ref _decodeErrors) % 30 == 1)
                    Diagnostic?.Invoke($"unrecognised decoder output ({s.Sample.Length} bytes for {w}x{h})");
                continue;
            }

            Interlocked.Increment(ref _framesDecoded);
            Interlocked.Exchange(ref _lastDecodedMs, _clock.ElapsedMilliseconds);
            Present(w, h, enqueuedMs);
            TickFps();
        }
    }

    // Mid-session resolution change: resize in place, never tear the pipeline down.
    private void EnsureBuffers(int w, int h)
    {
        if (_width == w && _height == h && _bgra != null) return;
        _width = w; _height = h;
        _bgra = new byte[checked(w * h * 4)];
        _bitmap = null; // rebuilt on the UI thread below
        Diagnostic?.Invoke($"source resolution now {w}x{h}");
    }

    private void Present(int w, int h, long enqueuedMs)
    {
        bool presented = false;
        if (_d3d.Available)
        {
            presented = _d3d.PushBgra(_bgra!, w, h);
            if (presented && !UsingD3D)
            {
                UsingD3D = true;
                RaiseSurface(_d3d.Image);
            }
        }

        if (!presented)
        {
            if (UsingD3D) { UsingD3D = false; Diagnostic?.Invoke("D3D present unavailable — using bitmap path"); }
            PresentBitmap(w, h);
        }

        _lastLatencyMs = _clock.ElapsedMilliseconds - enqueuedMs;
        if (Interlocked.Increment(ref _framesPresented) == 1)
            OnUi(() => FirstFrame?.Invoke());
    }

    private void PresentBitmap(int w, int h)
    {
        var copy = _bgra;
        if (copy == null) return;
        OnUi(() =>
        {
            try
            {
                if (_bitmap == null || _bitmap.PixelWidth != w || _bitmap.PixelHeight != h)
                {
                    _bitmap = new WriteableBitmap(w, h, 96, 96, PixelFormats.Bgra32, null);
                    SurfaceReady?.Invoke(_bitmap);
                }
                _bitmap.Lock();
                System.Runtime.InteropServices.Marshal.Copy(copy, 0, _bitmap.BackBuffer, w * h * 4);
                _bitmap.AddDirtyRect(new Int32Rect(0, 0, w, h));
            }
            catch { }
            finally { try { _bitmap?.Unlock(); } catch { } }
        });
    }

    private void RaiseSurface(ImageSource src) => OnUi(() => SurfaceReady?.Invoke(src));

    private static void OnUi(Action a)
    {
        var d = Application.Current?.Dispatcher;
        if (d == null) return;
        if (d.HasShutdownStarted || d.HasShutdownFinished) return;
        if (d.CheckAccess()) { a(); return; }
        try { d.BeginInvoke(a, System.Windows.Threading.DispatcherPriority.Render); }
        catch { }
    }

    private void TickFps()
    {
        var now = _clock.ElapsedMilliseconds;
        _fpsWindowFrames++;
        if (_fpsWindowStart == 0) { _fpsWindowStart = now; return; }
        var span = now - _fpsWindowStart;
        if (span < 1000) return;
        _fps = _fpsWindowFrames * 1000.0 / span;
        _fpsWindowStart = now;
        _fpsWindowFrames = 0;
    }

    // Phase 4 — keyframe FIRST. The caller escalates to an ICE restart only if
    // this keeps firing.
    private void StartStallWatch()
    {
        var ct = _cts.Token;
        var t = new Thread(() =>
        {
            while (!ct.IsCancellationRequested)
            {
                try { Thread.Sleep(500); } catch { return; }
                if (ct.IsCancellationRequested) return;
                var last = Interlocked.Read(ref _lastDecodedMs);
                if (Interlocked.Read(ref _framesIn) == 0) continue;
                if (last < 0 || _clock.ElapsedMilliseconds - last > StallMs)
                {
                    try { KeyFrameRequested?.Invoke(); } catch { }
                }
            }
        })
        { IsBackground = true, Name = "connectlive-video-stallwatch" };
        t.Start();
    }

    /// <summary>Per-minute SOAK line (G1): fps, queue depth, working set, device churn.</summary>
    public string StatsLine()
    {
        long ws = 0;
        try { ws = Process.GetCurrentProcess().WorkingSet64 / (1024 * 1024); } catch { }
        return $"[video] fps={_fps:F1} queue={QueueDepth} in={Interlocked.Read(ref _framesIn)} " +
               $"decoded={FramesDecoded} dropped={FramesDropped} presented={FramesPresented} " +
               $"latency={_lastLatencyMs:F0}ms size={_width}x{_height} " +
               $"path={(UsingD3D ? "d3d" : "bitmap")} devices={_d3d.DeviceCreations} " +
               $"surfaces={_d3d.SurfaceAllocations} ws={ws}MB";
    }

    /// <summary>Session ended: flush queues, park the D3D surface, keep the device warm (G3).</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _cts.Cancel(); } catch { }
        lock (_qGate) _queue.Clear();
        try { _signal.Release(); } catch { }
        try { _decoder?.Dispose(); } catch { }
        _decoder = null;
        try { _d3d.Park(); } catch { }
        try { _d3d.Dispose(); } catch { }
        _bgra = null;
        _bitmap = null;
    }
}
