using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;

namespace ConnectLive.Agent;

/// <summary>
/// Click-through, topmost overlay that renders a shared note from the admin
/// on the user's screen. Non-interactive — the user cannot type into it and
/// mouse input passes straight through to whatever is beneath.
/// </summary>
public static class NoteOverlay
{
    private static Window? _win;
    private static TextBlock? _text;
    private static Border? _card;

    public static void Update(string? text)
    {
        var app = Application.Current;
        if (app == null) return;
        app.Dispatcher.Invoke(() =>
        {
            if (string.IsNullOrWhiteSpace(text)) { if (_win != null) { _card!.Visibility = Visibility.Collapsed; } return; }
            EnsureWindow();
            _text!.Text = text;
            _card!.Visibility = Visibility.Visible;
            if (!_win!.IsVisible) _win.Show();
        });
    }

    private static void EnsureWindow()
    {
        if (_win != null) return;
        _card = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(230, 31, 42, 68)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(255, 79, 124, 255)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(16, 12, 16, 12),
            MaxWidth = 520,
        };
        var stack = new StackPanel();
        var title = new TextBlock
        {
            Text = "ConnectLive · message from support",
            Foreground = new SolidColorBrush(Color.FromArgb(255, 185, 204, 255)),
            FontSize = 11,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 6),
        };
        _text = new TextBlock
        {
            Foreground = Brushes.White,
            FontSize = 14,
            TextWrapping = TextWrapping.Wrap,
        };
        stack.Children.Add(title);
        stack.Children.Add(_text);
        _card.Child = stack;

        var host = new Grid { Margin = new Thickness(24) };
        host.HorizontalAlignment = HorizontalAlignment.Center;
        host.VerticalAlignment = VerticalAlignment.Top;
        host.Children.Add(_card);

        _win = new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true,
            ShowInTaskbar = false,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = 0,
            Top = 0,
            Width = SystemParameters.PrimaryScreenWidth,
            Height = 200,
            Content = host,
            Focusable = false,
            IsHitTestVisible = false,
        };
        _win.SourceInitialized += (_, __) => MakeClickThrough(_win!);
    }

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x20;
    private const int WS_EX_TOOLWINDOW = 0x80;
    private const int WS_EX_NOACTIVATE = 0x08000000;

    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);

    private static void MakeClickThrough(Window w)
    {
        var hwnd = new WindowInteropHelper(w).Handle;
        var ex = GetWindowLong(hwnd, GWL_EXSTYLE);
        SetWindowLong(hwnd, GWL_EXSTYLE, ex | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
    }
}
