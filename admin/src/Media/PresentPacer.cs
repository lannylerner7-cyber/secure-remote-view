using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows;
using System.Windows.Media;

namespace ConnectLive.Admin.Media;

/// <summary>
/// S20 — present pacing.
///
/// The decoder produces frames whenever the network and libvpx feel like it;
/// WPF composes on the display's vsync cadence. Presenting straight off the
/// decode thread means two frames can land inside one composition tick (the
/// first is never seen) and the next tick can have none — that unevenness is
/// the micro-judder you feel even when fps looks fine.
///
/// This class decouples the two clocks:
///   * decoded frames are copied into a tiny drop-oldest buffer (1–2 frames);
///   * <see cref="CompositionTarget.Rendering"/> — which fires once per
///     composition pass, i.e. on the display cadence — takes exactly one frame
///     per tick and hands it to the presenter on the UI thread.
///
/// A one-frame cushion is enough to absorb normal arrival jitter; two is the
/// ceiling, because every buffered frame is added latency and a live view must
/// show "now". When the buffer is empty the tick simply repeats the last
/// composed surface, which is what WPF would do anyway.
///
/// Judder is measured here, not guessed: <see cref="JudderMs"/> is the mean
/// absolute deviation of present-to-present intervals over the last window,
/// so S18's telemetry line can show whether pacing actually helped.
/// </summary>
public sealed class PresentPacer : IDisposable
{
    /// <summary>Maximum frames held back to smooth arrival jitter. Above this we drop the oldest.</summary>
    private const int MaxDepth = 2;

    private readonly object _gate = new();
    private readonly Queue<Frame> _pending = new();
    private readonly ConcurrentBag<byte[]> _pool = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Action<byte[], int, int, long> _present;

    private bool _hooked;
    private bool _disposed;

    private long _lastPresentMs = -1;
    private long _intervalCount;
    private double _intervalSum;
    private double _deviationSum;
    private double _judderMs;
    private double _paceFps;
    private long _windowStart;
    private long _windowFrames;
    private long _skippedTicks;
    private long _dropped;

    private readonly struct Frame
    {
        public readonly byte[] Bgra;
        public readonly int Width;
        public readonly int Height;
        public readonly long EnqueuedMs;
        public Frame(byte[] bgra, int w, int h, long enqueuedMs)
        { Bgra = bgra; Width = w; Height = h; EnqueuedMs = enqueuedMs; }
    }

    /// <param name="present">
    /// Invoked on the UI thread, once per composition tick at most, with a
    /// buffer owned by the pacer (valid only for the duration of the call).
    /// </param>
    public PresentPacer(Action<byte[], int, int, long> present)
        => _present = present ?? throw new ArgumentNullException(nameof(present));

    /// <summary>Frames currently held back to smooth jitter (0–2 in steady state).</summary>
    public int Depth { get { lock (_gate) return _pending.Count; } }

    /// <summary>Mean absolute deviation of present-to-present intervals, in ms. Lower is smoother.</summary>
    public double JudderMs => _judderMs;

    /// <summary>Presents per second actually reaching the compositor.</summary>
    public double PaceFps => _paceFps;

    /// <summary>Composition ticks that had no frame to show (starved — the encoder, not the pacer).</summary>
    public long StarvedTicks => Interlocked.Read(ref _skippedTicks);

    /// <summary>Frames discarded because the cushion was already full (arrival burst).</summary>
    public long DroppedFrames => Interlocked.Read(ref _dropped);

    /// <summary>True when the pacer is riding the composition clock; false means it presents inline.</summary>
    public bool Paced => _hooked;

    /// <summary>
    /// Hand a decoded frame to the pacer. Safe from any thread; never blocks the
    /// decode loop. The source buffer is copied, so callers may reuse it.
    /// </summary>
    public void Submit(byte[] bgra, int width, int height, long enqueuedMs)
    {
        if (_disposed || bgra == null || width <= 0 || height <= 0) return;
        int need = width * height * 4;
        if (bgra.Length < need) return;

        EnsureHooked();

        var buf = Rent(need);
        Buffer.BlockCopy(bgra, 0, buf, 0, need);
        var frame = new Frame(buf, width, height, enqueuedMs);

        if (!_hooked)
        {
            // No dispatcher (unit/spike host): degrade to the old behaviour —
            // present inline rather than silently swallowing the video.
            PresentFrame(frame);
            return;
        }

        lock (_gate)
        {
            while (_pending.Count >= MaxDepth)
            {
                var old = _pending.Dequeue();
                Interlocked.Increment(ref _dropped);
                Recycle(old.Bgra);
            }
            _pending.Enqueue(frame);
        }
    }

    private void EnsureHooked()
    {
        if (_hooked || _disposed) return;
        var d = Application.Current?.Dispatcher;
        if (d == null || d.HasShutdownStarted || d.HasShutdownFinished) return;
        if (d.CheckAccess()) { Hook(); return; }
        try { d.BeginInvoke(new Action(Hook)); } catch { }
    }

    private void Hook()
    {
        if (_hooked || _disposed) return;
        CompositionTarget.Rendering += OnRendering;
        _hooked = true;
    }

    private void OnRendering(object? sender, EventArgs e)
    {
        if (_disposed) return;
        Frame frame;
        lock (_gate)
        {
            if (_pending.Count == 0) { Interlocked.Increment(ref _skippedTicks); return; }
            frame = _pending.Dequeue();
        }
        PresentFrame(frame);
    }

    private void PresentFrame(Frame frame)
    {
        try { _present(frame.Bgra, frame.Width, frame.Height, frame.EnqueuedMs); }
        catch { }
        finally { Recycle(frame.Bgra); }
        Measure();
    }

    private void Measure()
    {
        var now = _clock.ElapsedMilliseconds;
        if (_lastPresentMs >= 0)
        {
            double gap = now - _lastPresentMs;
            _intervalCount++;
            _intervalSum += gap;
            double mean = _intervalSum / _intervalCount;
            _deviationSum += Math.Abs(gap - mean);
            _judderMs = _deviationSum / _intervalCount;
        }
        _lastPresentMs = now;

        _windowFrames++;
        if (_windowStart == 0) { _windowStart = now; return; }
        long span = now - _windowStart;
        if (span < 1000) return;
        _paceFps = _windowFrames * 1000.0 / span;
        _windowStart = now;
        _windowFrames = 0;
        // Roll the judder window so a rough first second does not haunt the
        // number for the rest of the session.
        _intervalCount = Math.Min(_intervalCount, 120);
        _intervalSum = _intervalCount * (_intervalCount > 0 ? _intervalSum / Math.Max(1, _intervalCount) : 0);
        _deviationSum = _judderMs * _intervalCount;
    }

    private byte[] Rent(int size)
    {
        while (_pool.TryTake(out var b))
            if (b.Length >= size) return b;
        return new byte[size];
    }

    private void Recycle(byte[] b)
    {
        if (_disposed || b == null) return;
        if (_pool.Count < MaxDepth + 2) _pool.Add(b);
    }

    /// <summary>S18 — one fragment for the telemetry line.</summary>
    public string StatsFragment() =>
        $"pace={(_hooked ? "vsync" : "inline")} pacefps={_paceFps:F1} judder={_judderMs:F1}ms " +
        $"cushion={Depth} starved={StarvedTicks} pacedrop={DroppedFrames}";

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        void unhook()
        {
            if (!_hooked) return;
            CompositionTarget.Rendering -= OnRendering;
            _hooked = false;
        }
        var d = Application.Current?.Dispatcher;
        if (d == null || d.HasShutdownStarted || d.HasShutdownFinished) { _hooked = false; }
        else if (d.CheckAccess()) unhook();
        else { try { d.Invoke(unhook); } catch { _hooked = false; } }

        lock (_gate) _pending.Clear();
        while (_pool.TryTake(out _)) { }
    }
}
