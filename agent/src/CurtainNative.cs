using System;
using System.Drawing;
using System.Runtime.InteropServices;

namespace ConnectLive.Agent;

/// <summary>Checked native operations for an opaque, constant-alpha window.</summary>
internal static class CurtainNative
{
    internal const int WS_EX_TRANSPARENT = 0x00000020;
    internal const int WS_EX_NOACTIVATE = 0x08000000;
    internal const int WS_EX_LAYERED = 0x00080000;
    internal const int WS_EX_TOOLWINDOW = 0x00000080;
    internal const int WS_EX_TOPMOST = 0x00000008;
    internal const int RequiredExStyles = WS_EX_LAYERED | WS_EX_TRANSPARENT |
        WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
    private const int GWL_EXSTYLE = -20;
    private const uint LWA_ALPHA = 0x00000002, SWP_NOACTIVATE = 0x0010;
    private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    private static readonly IntPtr HWND_TOPMOST = new(-1);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("dwmapi.dll")]
    private static extern int DwmIsCompositionEnabled(out bool enabled);
    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    internal static CurtainApplyResult CheckComposition()
    {
        int hresult = DwmIsCompositionEnabled(out bool enabled);
        return hresult == 0 && enabled ? CurtainApplyResult.Success : CompositionFailure(hresult);
    }

    internal static CurtainApplyResult Prepare(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return CurtainApplyResult.Failed("display_unavailable");
        // CreateParams establishes the styles. Never patch WPF-owned styles.
        if (!SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA))
            return CurtainApplyResult.Failed("display_style_failed", Marshal.GetLastWin32Error());
        var styles = VerifyStyles(hwnd);
        if (!styles.Applied) return styles;
        if (!SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE))
            return CurtainApplyResult.Failed("capture_exclusion_failed", Marshal.GetLastWin32Error());
        var exclusion = VerifyExclusion(hwnd);
        if (!exclusion.Applied) return exclusion;
        // Affinity/composition changes are not necessarily applied at API return.
        int hresult = DwmFlush();
        return hresult == 0 ? CurtainApplyResult.Success : CompositionFailure(hresult);
    }

    internal static CurtainApplyResult Verify(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return CurtainApplyResult.Failed("display_unavailable");
        var styles = VerifyStyles(hwnd);
        // Read back only: do not silently repair lost exclusion after rendering.
        return styles.Applied ? VerifyExclusion(hwnd) : styles;
    }

    private static CurtainApplyResult VerifyStyles(IntPtr hwnd)
    {
        int styles = GetWindowLong(hwnd, GWL_EXSTYLE);
        int error = styles == 0 ? Marshal.GetLastWin32Error() : 0;
        if ((styles & RequiredExStyles) != RequiredExStyles)
            return CurtainApplyResult.Failed("display_style_failed", error);
        if (!GetLayeredWindowAttributes(hwnd, out _, out var alpha, out var flags))
            return CurtainApplyResult.Failed("display_style_failed", Marshal.GetLastWin32Error());
        return alpha == 255 && flags == LWA_ALPHA ? CurtainApplyResult.Success :
            CurtainApplyResult.Failed("display_style_failed");
    }

    private static CurtainApplyResult VerifyExclusion(IntPtr hwnd)
    {
        if (!GetWindowDisplayAffinity(hwnd, out var affinity))
            return CurtainApplyResult.Failed("capture_exclusion_unverified", Marshal.GetLastWin32Error());
        return affinity == WDA_EXCLUDEFROMCAPTURE ? CurtainApplyResult.Success :
            CurtainApplyResult.Failed("capture_exclusion_unverified");
    }

    internal static CurtainApplyResult Place(IntPtr hwnd, Rectangle bounds)
    {
        if (bounds.Width <= 0 || bounds.Height <= 0)
            return CurtainApplyResult.Failed("display_unavailable");
        if (!SetWindowPos(hwnd, HWND_TOPMOST, bounds.X, bounds.Y, bounds.Width, bounds.Height, SWP_NOACTIVATE))
            return CurtainApplyResult.Failed("display_placement_failed", Marshal.GetLastWin32Error());
        return VerifyBounds(hwnd, bounds);
    }

    internal static CurtainApplyResult VerifyBounds(IntPtr hwnd, Rectangle bounds)
    {
        if (!GetWindowRect(hwnd, out var rect))
            return CurtainApplyResult.Failed("display_placement_failed", Marshal.GetLastWin32Error());
        return rect.Left == bounds.Left && rect.Top == bounds.Top &&
            rect.Right == bounds.Right && rect.Bottom == bounds.Bottom ?
            CurtainApplyResult.Success : CurtainApplyResult.Failed("display_placement_failed");
    }

    internal static CurtainApplyResult FlushComposition()
    {
        int hresult = DwmFlush();
        return hresult == 0 ? CurtainApplyResult.Success : CompositionFailure(hresult);
    }

    private static CurtainApplyResult CompositionFailure(int hresult)
    {
        // DWM returns HRESULTs, not GetLastError. Keep that distinction explicit.
        Log.Warn($"curtain composition rejected: hresult=0x{hresult:X8}");
        return CurtainApplyResult.Failed("composition_unavailable",
            ((uint)hresult & 0xFFFF0000) == 0x80070000 ? hresult & 0xFFFF : null);
    }
}
