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
    /// <summary>S16 — consecutive unusable frames before the native path gives up instead of PLI-storming.</summary>
    private const int MaxConsecutiveFailures = 60;


    private readonly Queue<(byte[] data, long enqueuedMs)> _queue = new();
    private readonly object _qGate = new();
    private readonly SemaphoreSlim _signal = new(0);
    private readonly CancellationTokenSource _cts = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly D3DImageHost _d3d = new();
    /// <summary>S20 — releases one decoded frame per composition tick so motion is even.</summary>
    private readonly PresentPacer _pacer;

    private Thread? _worker;
    private VpxVideoEncoder? _decoder;
    private byte[]? _bgra;
    private int _width, _height;
    private WriteableBitmap? _bitmap;
    private volatile bool _disposed;

    // S16 — native-path health. Everything about "video never started" that used
    // to be invisible now lives in these three fields and is surfaced to the UI.
    private volatile bool _decoderDead;
    private string? _deadReason;
    private FrameConvert.Shape _chroma = FrameConvert.Shape.I420;
    private int _consecutiveFailures;


    // ---- G2 counters -----------------------------------------------------
    private long _framesIn, _framesDecoded, _framesDropped, _framesPresented, _decodeErrors;
    // S13 — loss gating
    private long _lossEvents, _framesGated;
    private volatile bool _awaitingKeyFrame;

    private long _lastDecodedMs = -1;
    private double _fps;
    private double _lastLatencyMs;
    private long _fpsWindowStart;
    private long _fpsWindowFrames;
    // S18 — wire bitrate. Bytes are counted where they arrive (Submit, network
    // thread) and converted to kbps on the same window that produces fps, so
    // the two numbers always describe the same second of the session.
    private long _bytesIn;
    private long _bytesWindow;
    private double _bitrateKbps;

    public long FramesDecoded => Interlocked.Read(ref _framesDecoded);
    public long FramesDropped => Interlocked.Read(ref _framesDropped);
    public long FramesPresented => Interlocked.Read(ref _framesPresented);
    public double Fps => _fps;
    /// <summary>S18 — received encoded video bitrate over the last fps window.</summary>
    public double BitrateKbps => _bitrateKbps;
    public long BytesReceived => Interlocked.Read(ref _bytesIn);
    public double LastLatencyMs => _lastLatencyMs;
    public int QueueDepth { get { lock (_qGate) return _queue.Count; } }
    public int SourceWidth => _width;
    public int SourceHeight => _height;


    /// <summary>True only while decoded frames are actually reaching the screen (Phase 6 pill honesty).</summary>
    public bool IsPresenting =>
        _lastDecodedMs >= 0 && (_clock.ElapsedMilliseconds - Interlocked.Read(ref _lastDecodedMs)) < 2000;

    /// <summary>True when the D3D present path is live; false means the WriteableBitmap fallback.</summary>

    public bool UsingD3D { get; private set; }

    public VideoPipeline()
    {
        _pacer = new PresentPacer(PresentPaced);
    }

    /// <summary>S20 — mean absolute deviation between presents (ms). Lower is smoother.</summary>
    public double JudderMs => _pacer.JudderMs;

    /// <summary>S20 — presents per second actually reaching the compositor.</summary>
    public double PaceFps => _pacer.PaceFps;

    /// <summary>S20 — true while presents ride the display's composition cadence.</summary>
    public bool PacedPresent => _pacer.Paced;

    /// <summary>
    /// S16 — HWND of the window that actually presents this video. Set it
    /// before <see cref="Start"/>; without it the D3D device binds to
    /// <c>MainWindow</c>, which is not the presenting window in this app.
    /// </summary>
    public IntPtr PresentationWindow
    {
        get => _d3d.PresentationWindow;
        set => _d3d.PresentationWindow = value;
    }


    /// <summary>S12 — D3D device-lost events seen this session (0 on a healthy box).</summary>
    public int D3DDeviceLosses => _d3d.DeviceLosses;

    /// <summary>S12 — how many of those losses were recovered without leaving the D3D path.</summary>
    public int D3DDeviceRecoveries => _d3d.DeviceRecoveries;

    /// <summary>S12 — device (re)creations; must stay at 1 across park/resume (G3).</summary>
    public int D3DDeviceCreations => _d3d.DeviceCreations;


    /// <summary>Raised (worker thread) when the pipeline wants a fresh keyframe from the agent.</summary>
    public event Action? KeyFrameRequested;

    /// <summary>Raised on the UI thread the first time a presentable surface exists, and on resize.</summary>
    public event Action<ImageSource>? SurfaceReady;

    /// <summary>Raised on the UI thread the first time a decoded frame is presented.</summary>
    public event Action? FirstFrame;

    /// <summary>Raised (worker thread) with a one-line human-readable problem description.</summary>
    public event Action<string>? Diagnostic;

    /// <summary>
    /// S16 — the native path cannot produce pictures at all (no VP8 decoder, or
    /// every decoded frame is unusable). Raised at most once per pipeline. The
    /// caller must stop treating this as a transport stall — no PLI, no ICE
    /// restart will fix it — and demote to the JPEG path immediately.
    /// </summary>
    public event Action<string>? NativeVideoUnavailable;

    /// <summary>S16 — false once the native path has given up; the reason is in <see cref="UnavailableReason"/>.</summary>
    public bool DecoderAvailable => !_decoderDead;

    /// <summary>S16 — why the native path gave up, or null while it is healthy.</summary>
    public string? UnavailableReason => _deadReason;

    public void Start()
    {
        if (_worker != null || _decoderDead) return;

        // S16 — the decoder is created HERE, on the caller's thread, before any
        // frame arrives. It used to be constructed inside the decode loop, so a
        // missing libvpx native dependency killed the worker thread silently:
        // frames queued forever, the stall watch fired a PLI every 500 ms, that
        // escalated into ICE restarts, and the technician was told the network
        // had stalled when in fact there was no decoder at all.
        if (!_useH264)
        {
            try { _decoder = new VpxVideoEncoder(); }
            catch (Exception ex)
            {
                MarkUnavailable("VP8 decoder unavailable: " + ex.Message);
                return;
            }
        }


        // S12 — device-lost is visible, not silent. A TDR, driver update, RDP
        // attach or dGPU/iGPU flip now says so in the session log and in the
        // per-minute telemetry line; if the D3D path retires itself the
        // Present() path below has already dropped to the bitmap presenter.
        _d3d.DeviceLost += reason =>
        {
            Diagnostic?.Invoke($"GPU device lost ({reason}) — rebuilding the present path");
            if (UsingD3D) UsingD3D = false;
        };
        _d3d.DeviceRecovered += () => Diagnostic?.Invoke("GPU device recovered — native present resumed");

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
    /// S16 — retire the native path once, loudly. Idempotent: later failures on
    /// the worker thread cannot re-raise it or spam the session log.
    /// </summary>
    private void MarkUnavailable(string reason)
    {
        if (_decoderDead) return;
        _decoderDead = true;
        _deadReason = reason;
        lock (_qGate) _queue.Clear();
        Diagnostic?.Invoke(reason + " — falling back to the JPEG path");
        try { NativeVideoUnavailable?.Invoke(reason); } catch { }
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
        if (_disposed || _decoderDead || encodedFrame == null || encodedFrame.Length == 0) return;
        Interlocked.Increment(ref _framesIn);
        // S18 — count bytes at the wire, before any gating/drop decision, so
        // the bitrate reads what the link delivered rather than what survived.
        Interlocked.Add(ref _bytesIn, encodedFrame.Length);
        Interlocked.Add(ref _bytesWindow, encodedFrame.Length);


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
        // S16 — the decoder is already built by Start(); this thread only runs
        // when there is one.
        var ct = _cts.Token;
        while (!ct.IsCancellationRequested)
        {
            try { _signal.Wait(ct); } catch { return; }
            if (_decoderDead) return;
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
            if (NoteFailure($"VP8 decode keeps failing ({ex.Message})")) return;
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

            if (!FrameConvert.ToBgra32(s.Sample, w, h, _bgra, _chroma))
            {
                // S16 — before giving up, try the other chroma reading once.
                // Packed I420 and NV12 have identical byte counts, so a decoder
                // that emits NV12 used to fail here on every single frame.
                var alt = _chroma == FrameConvert.Shape.I420 ? FrameConvert.Shape.Nv12 : FrameConvert.Shape.I420;
                if (FrameConvert.ToBgra32(s.Sample, w, h, _bgra, alt))
                {
                    _chroma = alt;
                    Diagnostic?.Invoke($"decoder output re-read as {alt} ({s.Sample.Length} bytes for {w}x{h})");
                }
                else
                {
                    if (Interlocked.Increment(ref _decodeErrors) % 30 == 1)
                        Diagnostic?.Invoke("unrecognised decoder output: " + FrameConvert.Describe(s.Sample.Length, w, h));
                    NoteFailure("decoder output is not a layout we can present: " +
                                FrameConvert.Describe(s.Sample.Length, w, h));
                    continue;
                }
            }

            Interlocked.Exchange(ref _consecutiveFailures, 0);
            Interlocked.Increment(ref _framesDecoded);
            Interlocked.Exchange(ref _lastDecodedMs, _clock.ElapsedMilliseconds);
            Present(w, h, enqueuedMs);
            TickFps();
        }
    }

    /// <summary>
    /// S16 — count one unusable frame. Returns true once the native path has
    /// been retired, so the caller stops asking for keyframes that cannot help.
    /// </summary>
    private bool NoteFailure(string reason)
    {
        if (_decoderDead) return true;
        if (Interlocked.Increment(ref _consecutiveFailures) < MaxConsecutiveFailures) return false;
        MarkUnavailable(reason);
        return true;
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

    /// <summary>
    /// S20 — decoded frames no longer go straight to the presenter. They are
    /// handed to the pacer, which releases exactly one per composition tick so
    /// motion is even instead of arriving in bursts.
    /// </summary>
    private void Present(int w, int h, long enqueuedMs)
    {
        _pacer.Submit(_bgra!, w, h, enqueuedMs);
    }

    private void PresentPaced(byte[] bgra, int w, int h, long enqueuedMs)
    {
        bool presented = false;
        if (_d3d.Available)
        {
            presented = _d3d.PushBgra(bgra, w, h);
            if (presented && !UsingD3D)
            {
                UsingD3D = true;
                RaiseSurface(_d3d.Image);
            }
        }

        if (!presented)
        {
            if (UsingD3D) { UsingD3D = false; Diagnostic?.Invoke("D3D present unavailable — using bitmap path"); }
            PresentBitmap(bgra, w, h);
        }

        _lastLatencyMs = _clock.ElapsedMilliseconds - enqueuedMs;
        if (Interlocked.Increment(ref _framesPresented) == 1)
            OnUi(() => FirstFrame?.Invoke());
    }

    private void PresentBitmap(byte[] bgra, int w, int h)
    {
        if (bgra == null) return;
        int need = w * h * 4;
        if (bgra.Length < need) return;
        var d = Application.Current?.Dispatcher;
        // S20 — the pacer owns the buffer only for the duration of this call,
        // so anything deferred to a later dispatcher turn must copy first.
        var copy = (d != null && d.CheckAccess()) ? bgra : (byte[])bgra.Clone();
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
                System.Runtime.InteropServices.Marshal.Copy(copy, 0, _bitmap.BackBuffer, need);
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
        var bytes = Interlocked.Exchange(ref _bytesWindow, 0);
        _bitrateKbps = bytes * 8.0 / span;   // bytes/ms * 8 == kbit/s
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
                // S16 — a retired native path is NOT a transport stall. Keyframe
                // requests here were the PLI storm that masked the real cause.
                if (_decoderDead) return;
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
               $"bitrate={_bitrateKbps:F0}kbps bytes={Interlocked.Read(ref _bytesIn)} " +
               $"path={(_decoderDead ? "unavailable" : UsingD3D ? "d3d" : "bitmap")} " +
               $"chroma={_chroma} loss={Interlocked.Read(ref _lossEvents)} " +

               $"gated={Interlocked.Read(ref _framesGated)} " +
               _pacer.StatsFragment() + " " +
               (_deadReason != null ? $"dead=\"{_deadReason}\" " : "") +
               _d3d.HealthLine() + $" ws={ws}MB";

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
        try { _pacer.Dispose(); } catch { }
        try { _d3d.Park(); } catch { }
        try { _d3d.Dispose(); } catch { }
        _bgra = null;
        _bitmap = null;
    }
}
