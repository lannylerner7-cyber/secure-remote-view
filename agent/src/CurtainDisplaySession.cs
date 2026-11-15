using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>Display adapter only; it cannot grant control or pause input.</summary>
internal interface ICurtainSurface : IDisposable
{
    Task Rendered { get; }
    bool IsVisible { get; }
    CurtainApplyResult Prepare();
    CurtainApplyResult ShowAndRender();
    CurtainApplyResult VerifyAfterRender();
    void Close();
}

/// <summary>
/// Owns one all-monitor activation. Lifecycle calls stay on the UI dispatcher;
/// only IsShown and TryRunWhileHidden may be called by the capture thread.
/// Kept independent of Windows so the actual lifecycle can be regression-tested.
/// </summary>
internal sealed class CurtainDisplaySession
{
    private readonly Func<IEnumerable<ICurtainSurface>> _createSurfaces;
    private readonly TimeSpan _renderTimeout;
    private readonly List<ICurtainSurface> _windows = new();
    private readonly object _captureGate = new();
    private CancellationTokenSource? _renderCancellation;
    private volatile bool _isShown;
    private bool _ready;
    private long _generation;

    internal CurtainDisplaySession(Func<IEnumerable<ICurtainSurface>> createSurfaces,
        TimeSpan? renderTimeout = null)
    {
        _createSurfaces = createSurfaces;
        _renderTimeout = renderTimeout ?? TimeSpan.FromSeconds(2);
    }

    internal bool IsShown => _isShown;
    internal int WindowCount => _windows.Count;

    internal async Task<CurtainApplyResult> ShowRenderedAsync()
    {
        if (_ready) return CurtainApplyResult.Success;
        if (_windows.Count != 0) return CurtainApplyResult.Failed("activation_busy");
        var generation = ++_generation;
        using var cancellation = new CancellationTokenSource();
        _renderCancellation = cancellation;
        try
        {
            // Verify EVERY hidden window before showing ANY of them.
            foreach (var window in _createSurfaces())
            {
                _windows.Add(window);
                var prepared = window.Prepare();
                if (!prepared.Applied) return Fail(generation, prepared);
            }
            if (_windows.Count == 0)
                return Fail(generation, CurtainApplyResult.Failed("display_unavailable"));
            var windows = _windows.ToArray();

            // Wait for an already-started GDI copy before any notice can appear.
            // All later fallback copies stay blocked throughout paint/cleanup.
            lock (_captureGate) _isShown = true;
            foreach (var window in windows)
            {
                var shown = window.ShowAndRender();
                if (!shown.Applied) return Fail(generation, shown);
            }
            await Task.WhenAll(windows.Select(window => window.Rendered))
                .WaitAsync(_renderTimeout, cancellation.Token);
            if (generation != _generation)
                return CurtainApplyResult.Failed("activation_cancelled");
            foreach (var window in windows)
            {
                var verified = window.VerifyAfterRender();
                if (!verified.Applied) return Fail(generation, verified);
            }
            _ready = true;
            return CurtainApplyResult.Success;
        }
        catch (Exception ex)
        {
            // An old completion must not hide a new explicit activation.
            if (generation != _generation)
                return CurtainApplyResult.Failed("activation_cancelled");
            return Fail(generation, CurtainApplyResult.Failed(
                ex is TimeoutException ? "display_render_timeout" : "display_render_failed",
                ex is Win32Exception native ? native.NativeErrorCode : null));
        }
        finally
        {
            if (ReferenceEquals(_renderCancellation, cancellation)) _renderCancellation = null;
        }
    }

    private CurtainApplyResult Fail(long generation, CurtainApplyResult failure)
    {
        if (generation != _generation) return CurtainApplyResult.Failed("activation_cancelled");
        Hide();
        return failure;
    }

    internal void Hide()
    {
        _generation++;
        _ready = false;
        var cancellation = _renderCancellation;
        _renderCancellation = null;
        try { cancellation?.Cancel(); } catch { }

        var remaining = new List<ICurtainSurface>();
        foreach (var window in _windows)
        {
            // Dispose is still attempted when Close throws.
            try { window.Close(); } catch { }
            try { window.Dispose(); } catch { }
            bool visible;
            try { visible = window.IsVisible; } catch { visible = true; }
            if (visible) remaining.Add(window);
        }
        _windows.Clear();
        _windows.AddRange(remaining);
        // Never announce off / permit unsafe capture until teardown completes.
        // A failed cleanup stays retryable rather than losing its HWND owner.
        lock (_captureGate) _isShown = remaining.Count != 0;
    }

    internal bool TryRunWhileHidden(Action capture)
    {
        lock (_captureGate)
        {
            if (_isShown) return false;
            capture();
            return true;
        }
    }
}
