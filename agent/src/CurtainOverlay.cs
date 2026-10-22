using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Forms;

namespace ConnectLive.Agent;

/// <summary>
/// Full-screen "maintenance in progress" curtain covering every attached
/// monitor. Excluded from screen capture via SetWindowDisplayAffinity so
/// the admin's stream stays clean while the physical user sees the notice.
///
/// The overlay is display-only: physical input is disabled at the OS layer
/// by InputBlocker, and admin input arrives via SendInput which is not
/// affected by BlockInput while the agent runs elevated.
/// </summary>
public sealed class CurtainOverlay
{
    [DllImport("user32.dll")] private static extern uint SetWindowDisplayAffinity(IntPtr hwnd, uint dwAffinity);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)] private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_LAYERED = 0x00080000;

    private static readonly List<Window> _windows = new();
    private static bool _active;

    public static bool IsShown => _active;

    public static bool Show()
    {
        if (_active) return true;
        try
        {
            foreach (var screen in Screen.AllScreens)
            {
                var w = BuildWindow(screen);
                _windows.Add(w);
                w.Show();
                var hwnd = new WindowInteropHelper(w).Handle;
                ApplyGhostStyles(hwnd);
                if (SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) == 0)
                    throw new InvalidOperationException("Windows rejected curtain capture exclusion.");
            }
            if (_windows.Count == 0) throw new InvalidOperationException("No display available for curtain.");
            _active = true;
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("curtain not applied: " + ex.Message);
            Hide();
            return false;
        }
    }

    public static void Hide()
    {
        _active = false;
        foreach (var w in _windows)
        {
            try { w.Close(); } catch { }
        }
        _windows.Clear();
    }

    private static Window BuildWindow(Screen screen)
    {
        var w = new Window
        {
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = new SolidColorBrush(Color.FromArgb(140, 8, 12, 24)),
            Topmost = true,
            ShowActivated = false,
            ShowInTaskbar = false,
            Focusable = false,
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = screen.Bounds.Left,
            Top = screen.Bounds.Top,
            Width = screen.Bounds.Width,
            Height = screen.Bounds.Height,
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
            Text = "Your keyboard and mouse are temporarily disabled. To override and regain control at any time, press Ctrl + Alt + Del.",
            Foreground = new SolidColorBrush(Color.FromArgb(220, 255, 255, 255)),
            FontSize = 13,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 10, 0, 0),
        });

        card.Child = stack;
        w.Content = card;
        return w;
    }

    private static void ApplyGhostStyles(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        var style = GetWindowLong(hwnd, GWL_EXSTYLE);
        // Layered keeps transparency; transparent/noactivate make the curtain a
        // true "ghost" overlay so focus stays on the app underneath while local
        // physical input is blocked separately by InputBlocker.
        SetWindowLong(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);
    }
}
