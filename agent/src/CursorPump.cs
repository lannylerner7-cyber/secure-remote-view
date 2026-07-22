using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Phase-1 upgrade: stream cursor position + cursor "kind" (arrow, hand,
/// text beam, resize, wait…) at ~30 Hz on a separate channel from the JPEG
/// frames. The admin panel renders an SVG cursor overlay on top of the
/// &lt;img&gt;, so the pointer glides at native display refresh even when
/// video drops to 2 fps. Matches the technique ConnectWise / Parsec use.
///
/// Coordinates are emitted in the same scaled space the frame stream uses
/// (max 1280px long edge) so admin math is trivial: overlay uses the same
/// image element bounds.
/// </summary>
public static class CursorPump
{
    private const int MaxEdge = 1280;         // must match ScreenCapture
    private const int PeriodMs = 33;          // ~30 Hz

    private const uint CURSOR_SHOWING = 0x00000001;

    // Cached standard cursor handles, resolved once on first tick.
    private static IntPtr _hArrow, _hIBeam, _hHand, _hWait, _hCross,
                          _hSizeAll, _hSizeNS, _hSizeWE, _hSizeNESW, _hSizeNWSE,
                          _hNo, _hHelp, _hAppStarting;
    private static bool _cursorsLoaded;

    public static async Task RunAsync(ApiClient api, string sessionId, CancellationToken ct)
    {
        EnsureCursorsLoaded();

        int lastX = int.MinValue, lastY = int.MinValue;
        string lastKind = "";
        bool lastVisible = true;
        long lastPostTicks = 0;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var bounds = System.Windows.Forms.Screen.PrimaryScreen?.Bounds
                             ?? new Rectangle(0, 0, 1920, 1080);
                double scale = Math.Min(1.0, (double)MaxEdge / Math.Max(bounds.Width, bounds.Height));
                int w = Math.Max(1, (int)(bounds.Width * scale));
                int h = Math.Max(1, (int)(bounds.Height * scale));

                var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
                bool ok = GetCursorInfo(ref info);
                bool visible = ok && (info.flags & CURSOR_SHOWING) != 0;
                int sx = ok ? (int)Math.Round((info.ptScreenPos.X - bounds.Left) * scale) : 0;
                int sy = ok ? (int)Math.Round((info.ptScreenPos.Y - bounds.Top) * scale) : 0;
                string kind = visible ? MapCursorKind(info.hCursor) : "hidden";

                // Post if anything changed OR at least every 500 ms as a keepalive.
                long nowTicks = Environment.TickCount64;
                bool changed = sx != lastX || sy != lastY || kind != lastKind || visible != lastVisible;
                if (changed || (nowTicks - lastPostTicks) > 500)
                {
                    lastX = sx; lastY = sy; lastKind = kind; lastVisible = visible;
                    lastPostTicks = nowTicks;
                    _ = api.PostCursorAsync(sessionId, sx, sy, w, h, kind, visible, ct);
                }
            }
            catch (Exception ex) { Log.Warn($"cursor: {ex.Message}"); }

            try { await Task.Delay(PeriodMs, ct); } catch { }
        }
    }

    private static void EnsureCursorsLoaded()
    {
        if (_cursorsLoaded) return;
        _hArrow       = LoadCursor(IntPtr.Zero, (IntPtr)32512);
        _hIBeam       = LoadCursor(IntPtr.Zero, (IntPtr)32513);
        _hWait        = LoadCursor(IntPtr.Zero, (IntPtr)32514);
        _hCross       = LoadCursor(IntPtr.Zero, (IntPtr)32515);
        _hSizeNWSE    = LoadCursor(IntPtr.Zero, (IntPtr)32642);
        _hSizeNESW    = LoadCursor(IntPtr.Zero, (IntPtr)32643);
        _hSizeWE      = LoadCursor(IntPtr.Zero, (IntPtr)32644);
        _hSizeNS      = LoadCursor(IntPtr.Zero, (IntPtr)32645);
        _hSizeAll     = LoadCursor(IntPtr.Zero, (IntPtr)32646);
        _hNo          = LoadCursor(IntPtr.Zero, (IntPtr)32648);
        _hHand        = LoadCursor(IntPtr.Zero, (IntPtr)32649);
        _hAppStarting = LoadCursor(IntPtr.Zero, (IntPtr)32650);
        _hHelp        = LoadCursor(IntPtr.Zero, (IntPtr)32651);
        _cursorsLoaded = true;
    }

    private static string MapCursorKind(IntPtr h)
    {
        if (h == IntPtr.Zero) return "default";
        if (h == _hArrow)       return "default";
        if (h == _hIBeam)       return "text";
        if (h == _hHand)        return "pointer";
        if (h == _hWait)        return "wait";
        if (h == _hAppStarting) return "progress";
        if (h == _hCross)       return "crosshair";
        if (h == _hSizeAll)     return "move";
        if (h == _hSizeNS)      return "ns-resize";
        if (h == _hSizeWE)      return "ew-resize";
        if (h == _hSizeNESW)    return "nesw-resize";
        if (h == _hSizeNWSE)    return "nwse-resize";
        if (h == _hNo)          return "not-allowed";
        if (h == _hHelp)        return "help";
        return "default";
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] private static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);
}
