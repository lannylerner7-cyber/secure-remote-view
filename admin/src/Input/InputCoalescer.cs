using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;

namespace ConnectLive.Admin.Input;

/// <summary>
/// Debounces high-frequency mouse-move updates. UI thread calls Update(x,y)
/// on every WPF MouseMove; a per-frame CompositionTarget.Rendering flush
/// ships only the latest pair — matches the web console's rAF cadence so a
/// 1000Hz mouse never floods the network and there's no background-timer
/// jitter floor. Buttons/wheel/keys go through MouseInjector/KeyboardInjector
/// directly and stay ordered by calling FlushNow() first.
/// </summary>
public sealed class InputCoalescer
{
    private readonly MouseInjector _mouse;
    private volatile int _pending;
    private double _x, _y;
    private EventHandler? _tickHandler;
    private bool _running;

    public InputCoalescer(MouseInjector mouse) => _mouse = mouse;

    public void Start()
    {
        if (_running) return;
        _running = true;
        _tickHandler = (_, _) => TryFlush();
        // Subscribe on the UI thread; CompositionTarget.Rendering fires once
        // per WPF render pass on the same dispatcher.
        Application.Current?.Dispatcher.Invoke(() =>
        {
            CompositionTarget.Rendering += _tickHandler;
        });
    }

    public void Stop()
    {
        if (!_running) return;
        _running = false;
        var h = _tickHandler;
        _tickHandler = null;
        Application.Current?.Dispatcher.Invoke(() =>
        {
            if (h != null) CompositionTarget.Rendering -= h;
        });
    }

    public void Update(double x, double y)
    {
        _x = x;
        _y = y;
        _pending = 1;
    }

    /// <summary>
    /// Flush any queued move immediately. Call before an ordered event
    /// (mousedown/up, wheel, key) so a click never lands ahead of the move
    /// that positioned it.
    /// </summary>
    public void FlushNow() => TryFlush();

    private void TryFlush()
    {
        if (Interlocked.Exchange(ref _pending, 0) != 1) return;
        double x = _x, y = _y;
        _ = Task.Run(async () => { try { await _mouse.MoveAsync(x, y); } catch { } });
    }
}
