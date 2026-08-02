using System;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Phase 5 — the single source of truth for "where inside this element is the
/// picture actually drawn".
///
/// Everything that converts between element-space (WPF pixels inside the
/// <c>Image</c>) and source-space (the remote desktop's own pixels) MUST go
/// through here: <c>ToAbs()</c>, the cursor ghost, and the wheel position.
/// Previously each of those divided by <c>ActualWidth</c>/<c>ActualHeight</c>,
/// which silently includes the letterbox bars produced by
/// <c>Stretch="Uniform"</c> — so a click near an edge landed several dozen
/// pixels off on the remote machine, and the ghost cursor drifted.
///
/// Transport-agnostic by design (pure math, no WPF/WebRTC types) so the future
/// datachannel input swap touches transport only, never the geometry.
/// </summary>
public readonly struct ContentRect
{
    public double OffsetX { get; }
    public double OffsetY { get; }
    public double DrawnWidth { get; }
    public double DrawnHeight { get; }

    /// <summary>False when the element or the source has no usable size yet.</summary>
    public bool IsValid => DrawnWidth > 0 && DrawnHeight > 0;

    private ContentRect(double offsetX, double offsetY, double drawnW, double drawnH)
    {
        OffsetX = offsetX;
        OffsetY = offsetY;
        DrawnWidth = drawnW;
        DrawnHeight = drawnH;
    }

    public static readonly ContentRect Empty = new(0, 0, 0, 0);

    /// <summary>
    /// scale  = min(elemW/srcW, elemH/srcH)
    /// drawn  = src * scale
    /// offset = (elem - drawn) / 2
    /// </summary>
    public static ContentRect Compute(double elemW, double elemH, double srcW, double srcH)
    {
        if (elemW <= 0 || elemH <= 0 || srcW <= 0 || srcH <= 0) return Empty;
        var scale = Math.Min(elemW / srcW, elemH / srcH);
        var drawnW = srcW * scale;
        var drawnH = srcH * scale;
        return new ContentRect((elemW - drawnW) / 2.0, (elemH - drawnH) / 2.0, drawnW, drawnH);
    }

    /// <summary>Element point → normalised source point, clamped to [0,1].</summary>
    public (double x, double y) Normalize(double pointX, double pointY)
    {
        if (!IsValid) return (0, 0);
        var nx = (pointX - OffsetX) / DrawnWidth;
        var ny = (pointY - OffsetY) / DrawnHeight;
        return (Math.Clamp(nx, 0, 1), Math.Clamp(ny, 0, 1));
    }

    /// <summary>Normalised source point → element point (for the cursor ghost).</summary>
    public (double x, double y) ToElement(double normX, double normY)
    {
        if (!IsValid) return (0, 0);
        return (OffsetX + Math.Clamp(normX, 0, 1) * DrawnWidth,
                OffsetY + Math.Clamp(normY, 0, 1) * DrawnHeight);
    }

    /// <summary>True when the element point falls on the picture, not the letterbox bar.</summary>
    public bool Contains(double pointX, double pointY)
        => IsValid &&
           pointX >= OffsetX && pointX <= OffsetX + DrawnWidth &&
           pointY >= OffsetY && pointY <= OffsetY + DrawnHeight;
}
