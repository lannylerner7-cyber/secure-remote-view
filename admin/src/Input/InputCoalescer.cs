using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Input;

/// <summary>
/// Debounces high-frequency mouse-move updates. UI thread calls Update(x,y)
/// on every WPF MouseMove; a background 60Hz loop flushes only the latest
/// pair, so a 1000Hz mouse never floods the network.
/// </summary>
public sealed class InputCoalescer
{
    private readonly MouseInjector _mouse;
    private volatile int _pending;
    private double _x, _y;
    private CancellationTokenSource? _cts;

    public InputCoalescer(MouseInjector mouse) => _mouse = mouse;

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _ = Task.Run(() => Loop(_cts.Token));
    }

    public void Stop() => _cts?.Cancel();

    public void Update(double x, double y)
    {
        _x = x;
        _y = y;
        _pending = 1;
    }

    private async Task Loop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            if (System.Threading.Interlocked.Exchange(ref _pending, 0) == 1)
            {
                try { await _mouse.MoveAsync(_x, _y, ct); } catch { }
            }
            try { await Task.Delay(16, ct); } catch { }
        }
    }
}
