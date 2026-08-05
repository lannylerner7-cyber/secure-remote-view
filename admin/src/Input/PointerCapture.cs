using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media;

namespace ConnectLive.Admin.Input;

/// <summary>
/// S19(b) — WPF has no pointer-lock, so we build the equivalent: while capture
/// is engaged the OS cursor is parked at the centre of the live surface and
/// every physical move is read as a delta from that anchor, then the cursor is
/// warped back. That gives the technician an unbounded, 1:1 pointer (the
/// remote pointer can travel past the edge of our window) which is exactly how
/// enterprise consoles feel, and it removes the letterbox/edge clamping that
/// absolute mapping imposes.
///
/// The anchor is recomputed on every engage and on every element resize, and
/// warps we performed ourselves are ignored (a SetCursorPos generates a
/// WM_MOUSEMOVE that would otherwise be read as a second, mirrored delta).
/// </summary>
public sealed class PointerCapture
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    private readonly FrameworkElement _surface;
    private Point _anchorScreen;       // device pixels
    private bool _engaged;
    private bool _selfWarp;

    public PointerCapture(FrameworkElement surface) => _surface = surface;

    public bool Engaged => _engaged;

    /// <summary>Engage capture and park the cursor on the anchor.</summary>
    public bool Engage()
    {
        if (_engaged) return true;
        if (!TryComputeAnchor(out _anchorScreen)) return false;
        _engaged = true;
        _surface.CaptureMouse();
        Warp();
        return true;
    }

    public void Release()
    {
        if (!_engaged) return;
        _engaged = false;
        _selfWarp = false;
        _surface.ReleaseMouseCapture();
    }

    /// <summary>Recompute the anchor after a resize/scroll without dropping capture.</summary>
    public void Recenter()
    {
        if (!_engaged) return;
        if (!TryComputeAnchor(out _anchorScreen)) return;
        Warp();
    }

    /// <summary>
    /// Convert a physical cursor position (screen device pixels) into a delta
    /// from the anchor, then re-park. Returns false when this move was our own
    /// warp or capture is not engaged.
    /// </summary>
    public bool Consume(Point screenPoint, out int dx, out int dy)
    {
        dx = dy = 0;
        if (!_engaged) return false;
        if (_selfWarp) { _selfWarp = false; return false; }

        dx = (int)Math.Round(screenPoint.X - _anchorScreen.X);
        dy = (int)Math.Round(screenPoint.Y - _anchorScreen.Y);
        if (dx == 0 && dy == 0) return false;

        Warp();
        return true;
    }

    private void Warp()
    {
        _selfWarp = true;
        try { SetCursorPos((int)Math.Round(_anchorScreen.X), (int)Math.Round(_anchorScreen.Y)); }
        catch { _selfWarp = false; }
    }

    private bool TryComputeAnchor(out Point screen)
    {
        screen = default;
        if (_surface.ActualWidth <= 0 || _surface.ActualHeight <= 0) return false;
        var src = PresentationSource.FromVisual(_surface);
        if (src?.CompositionTarget == null) return false;
        try
        {
            var mid = new Point(_surface.ActualWidth / 2, _surface.ActualHeight / 2);
            // PointToScreen already yields device pixels on the target monitor,
            // so no extra DPI scaling is applied here.
            screen = _surface.PointToScreen(mid);
            return true;
        }
        catch { return false; }
    }
}
