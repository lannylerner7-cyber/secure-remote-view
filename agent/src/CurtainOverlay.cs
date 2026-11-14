using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Forms;
using System.Threading.Tasks;
using System.Linq;

namespace ConnectLive.Agent;

/// <summary>
/// Full-screen "maintenance in progress" curtain covering every attached
/// monitor. Excluded from screen capture via SetWindowDisplayAffinity so
/// the admin's stream stays clean while the physical user sees the notice.
///
/// The overlay is display-only: physical input is disabled at the OS layer
/// by an ordinary-desktop input filter. It neither elevates nor replaces
/// Windows security boundaries. Capture exclusion requires Windows testing.
/// </summary>
public sealed class CurtainOverlay
{
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SetWindowDisplayAffinity(IntPtr hwnd, uint dwAffinity);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)] private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint colorKey, byte alpha, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmIsCompositionEnabled(out bool enabled);

    private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_LAYERED = 0x00080000;
    private const uint LWA_ALPHA = 0x00000002;

    private static readonly List<Window> _windows = new();
    private static readonly List<TaskCompletionSource<bool>> _rendered = new();
    private static volatile bool _active;
    private static long _generation;

    public static bool IsShown => _active;

    private static CurtainApplyResult Show()
    {
        if (_active) return CurtainApplyResult.Success;
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
            return CurtainApplyResult.Failed("unsupported_windows");
        _generation++;
        try
        {
            if (DwmIsCompositionEnabled(out var composed) != 0 || !composed)
                return Fail("composition_unavailable");
            foreach (var screen in Screen.AllScreens)
            {
                var w = BuildWindow(screen);
                _windows.Add(w);
                var rendered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                _rendered.Add(rendered);
                w.ContentRendered += (_, _) => rendered.TrySetResult(true);
                // Create the HWND while still hidden. Never show even a first
                // frame before Windows accepts the requested capture exclusion.
                var hwnd = new WindowInteropHelper(w).EnsureHandle();
                if (!ApplyGhostStyles(hwnd))
                    return Fail("display_style_failed", Marshal.GetLastWin32Error());
                var exclusion = VerifyExclusion(hwnd);
                if (!exclusion.Applied) return Fail(exclusion.Reason!, exclusion.NativeError);
                var bounds = screen.Bounds;
                if (!SetWindowPos(hwnd, HWND_TOPMOST, bounds.Left, bounds.Top, bounds.Width, bounds.Height, SWP_NOACTIVATE))
                    return Fail("display_placement_failed", Marshal.GetLastWin32Error());
                w.Show();
                // Native pixel bounds avoid treating per-monitor physical
                // pixels as WPF DIPs. Reassert after WPF's first layout pass.
                if (!SetWindowPos(hwnd, HWND_TOPMOST, bounds.Left, bounds.Top, bounds.Width, bounds.Height, SWP_NOACTIVATE))
                    return Fail("display_placement_failed", Marshal.GetLastWin32Error());
            }
            if (_windows.Count == 0) return Fail("display_unavailable");
            _active = true;
            return CurtainApplyResult.Success;
        }
        catch (Exception ex)
        {
            Log.Warn($"curtain window creation failed: type={ex.GetType().Name}");
            return Fail("display_render_failed");
        }
    }

    internal static async Task<CurtainApplyResult> ShowRenderedAsync()
    {
        var result = Show();
        if (!result.Applied) return result;
        var generation = _generation;
        var windows = _windows.ToArray();
        var rendered = _rendered.ToArray();
        try
        {
            await Task.WhenAll(rendered.Select(signal => signal.Task)).WaitAsync(TimeSpan.FromSeconds(2));
            if (generation != _generation) return CurtainApplyResult.Failed("activation_cancelled");
            // WPF may update native window state during Show/first render.
            // Never acknowledge a curtain based only on the hidden HWND check.
            foreach (var window in windows)
            {
                var hwnd = new WindowInteropHelper(window).Handle;
                if (!ApplyGhostStyles(hwnd))
                    return Fail("display_style_failed", Marshal.GetLastWin32Error());
                var exclusion = VerifyExclusion(hwnd);
                if (!exclusion.Applied) return Fail(exclusion.Reason!, exclusion.NativeError);
            }
            return _active ? CurtainApplyResult.Success : CurtainApplyResult.Failed("activation_cancelled");
        }
        catch (Exception ex)
        {
            // A late render cancellation must not hide a newer activation.
            if (generation != _generation) return CurtainApplyResult.Failed("activation_cancelled");
            return Fail(ex is TimeoutException ? "display_render_timeout" : "display_render_failed");
        }
    }

    private static CurtainApplyResult VerifyExclusion(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return CurtainApplyResult.Failed("display_unavailable");
        if (SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) == 0)
            return CurtainApplyResult.Failed("capture_exclusion_failed", Marshal.GetLastWin32Error());
        if (!GetWindowDisplayAffinity(hwnd, out var affinity))
            return CurtainApplyResult.Failed("capture_exclusion_unverified", Marshal.GetLastWin32Error());
        return affinity == WDA_EXCLUDEFROMCAPTURE ? CurtainApplyResult.Success :
            CurtainApplyResult.Failed("capture_exclusion_unverified");
    }

    private static CurtainApplyResult Fail(string reason, int? nativeError = null)
    {
        var result = CurtainApplyResult.Failed(reason, nativeError);
        Log.Warn($"curtain display rejected: reason={result.Reason} native_error={result.NativeError}");
        Hide();
        return result;
    }

    public static void Hide()
    {
        _generation++;
        _active = false;
        foreach (var w in _windows)
        {
            try { w.Close(); } catch { }
        }
        _windows.Clear();
        foreach (var signal in _rendered) signal.TrySetCanceled();
        _rendered.Clear();
    }

    private static Window BuildWindow(Screen screen)
    {
        var w = new Window
        {
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            // An opaque, DWM-redirected surface does not need WPF's per-pixel
            // UpdateLayeredWindow path, which can reject display affinity.
            AllowsTransparency = false,
            Background = new SolidColorBrush(Color.FromRgb(8, 12, 24)),
            Topmost = true,
            ShowActivated = false,
            ShowInTaskbar = false,
            Focusable = false,
            WindowStartupLocation = WindowStartupLocation.Manual,
            Width = 1,
            Height = 1,
            Title = "ConnectLive maintenance",
        };

        var card = new Border
        {
            CornerRadius = new CornerRadius(14),
            Background = new SolidColorBrush(Color.FromRgb(0x1F, 0x2A, 0x44)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(90, 0x4F, 0x7C, 0xFF)),
            BorderThickness = new Thickness(1),
            Padding = new Thickness(28, 22, 28, 22),
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            VerticalAlignment = System.Windows.VerticalAlignment.Center,
            MaxWidth = 520,
        };

        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = "ConnectLive · maintenance in progress",
            Foreground = new SolidColorBrush(Color.FromRgb(0xB9, 0xCC, 0xFF)),
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 8),
        });
        stack.Children.Add(new TextBlock
        {
            Text = "Your IT administrator is performing maintenance on this computer.",
            Foreground = Brushes.White,
            FontSize = 18,
            FontWeight = FontWeights.SemiBold,
            TextWrapping = TextWrapping.Wrap,
        });
        stack.Children.Add(new TextBlock
        {
            Text = "Local keyboard and mouse input is temporarily paused. Press Ctrl + Alt + Shift + Esc to stop remote access. Windows Ctrl + Alt + Del remains available.",
            Foreground = new SolidColorBrush(Color.FromArgb(220, 255, 255, 255)),
            FontSize = 13,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 10, 0, 0),
        });

        card.Child = stack;
        w.Content = card;
        return w;
    }

    private static bool ApplyGhostStyles(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        var style = GetWindowLong(hwnd, GWL_EXSTYLE);
        // Keep click-through and no-activation behavior, but use constant
        // opaque alpha rather than WPF's per-pixel transparent-window renderer.
        // SetLayeredWindowAttributes is required after adding WS_EX_LAYERED.
        SetWindowLong(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);
        return SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
    }
}
