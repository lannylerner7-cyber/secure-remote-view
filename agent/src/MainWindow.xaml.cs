using System;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace ConnectLive.Agent;

/// <summary>
/// Status window, shown only on a foreground launch. Closing it (X) hides the
/// window instead of exiting — the heartbeat loop keeps running for the whole
/// process lifetime. Ending the process (Task Manager / sign-out) is the only
/// stop; the logon triggers bring the Agent back at the next sign-in.
/// </summary>
public sealed class MainWindow : Window
{
    private readonly TextBlock _link;
    private readonly TextBlock _device;
    private readonly TextBlock _session;

    /// <summary>Set false by the app right before an explicit shutdown.</summary>
    public bool HideInsteadOfClose { get; set; } = true;

    public MainWindow()
    {
        Title = "ConnectLive Agent";
        Width = 460; Height = 320;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        ResizeMode = ResizeMode.CanMinimize;
        Background = (Brush)Application.Current.Resources["BrandSurface"];
        ShowInTaskbar = true;

        var stack = new StackPanel { Margin = new Thickness(28, 24, 28, 24) };

        var wordmark = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 4) };
        wordmark.Children.Add(new Ellipse
        {
            Width = 12, Height = 12,
            Fill = (Brush)Application.Current.Resources["BrandAccent"],
            Margin = new Thickness(0, 5, 9, 0),
            VerticalAlignment = VerticalAlignment.Center
        });
        wordmark.Children.Add(new TextBlock
        {
            Text = "ConnectLive",
            FontSize = 24,
            FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Application.Current.Resources["BrandInk"]
        });
        stack.Children.Add(wordmark);

        stack.Children.Add(new TextBlock
        {
            Text = "Transparent remote support — this device is managed.",
            FontSize = 12,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            Margin = new Thickness(0, 0, 0, 22)
        });

        _link = Row(stack, "Connection", "Starting…");
        _device = Row(stack, "Device", "—");
        _session = Row(stack, "Session", "No active session");

        stack.Children.Add(new TextBlock
        {
            Text = "Closing this window keeps ConnectLive running quietly in the background. "
                 + "It restarts automatically the next time you sign in to Windows.",
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            Margin = new Thickness(0, 20, 0, 0)
        });

        Content = stack;

        Closing += OnClosing;
    }

    private static TextBlock Row(Panel parent, string label, string value)
    {
        var grid = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(96) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var l = new TextBlock
        {
            Text = label,
            FontSize = 12,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"]
        };
        Grid.SetColumn(l, 0);
        grid.Children.Add(l);

        var v = new TextBlock
        {
            Text = value,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Foreground = (Brush)Application.Current.Resources["BrandInk"]
        };
        Grid.SetColumn(v, 1);
        grid.Children.Add(v);

        parent.Children.Add(grid);
        return v;
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (!HideInsteadOfClose) return;
        e.Cancel = true;
        Hide();
    }

    public void SetLink(string text) => Dispatcher.Invoke(() => _link.Text = text);
    public void SetDevice(string text) => Dispatcher.Invoke(() => _device.Text = text);
    public void SetSession(string text) => Dispatcher.Invoke(() => _session.Text = text);

    public void ShowAndActivate()
    {
        Dispatcher.Invoke(() =>
        {
            Show();
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            Topmost = true;
            Activate();
            Topmost = false;
        });
    }
}
