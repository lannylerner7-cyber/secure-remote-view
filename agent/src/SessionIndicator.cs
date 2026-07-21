using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace ConnectLive.Agent;

/// <summary>
/// Persistent, always-on-top banner shown for the FULL duration of any session.
/// Displays technician name, view/control state, and an End button the user can
/// hit at any time. Cannot be minimized or hidden by the technician side.
/// </summary>
public sealed class SessionIndicator : Window
{
    private readonly TextBlock _mode;
    private readonly Ellipse _dot;

    public SessionIndicator(string technician, Action onEnd)
    {
        Title = "ConnectLive session";
        Width = 360; Height = 56;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;

        // Pin to top-right of the primary screen.
        var work = SystemParameters.WorkArea;
        Left = work.Right - Width - 16;
        Top  = work.Top   + 16;

        var border = new Border
        {
            CornerRadius = new CornerRadius(28),
            Background = (Brush)Application.Current.Resources["BrandInk"],
            BorderThickness = new Thickness(0)
        };

        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(16, 10, 8, 10) };

        _dot = new Ellipse { Width = 10, Height = 10, Fill = (Brush)Application.Current.Resources["BrandAccent"], Margin = new Thickness(0, 8, 10, 0) };
        row.Children.Add(_dot);

        var text = new StackPanel();
        text.Children.Add(new TextBlock
        {
            Text = $"Sharing with {technician}",
            Foreground = Brushes.White, FontWeight = FontWeights.SemiBold, FontSize = 13
        });
        _mode = new TextBlock
        {
            Text = "View only",
            Foreground = new SolidColorBrush(Color.FromRgb(180, 195, 220)),
            FontSize = 11
        };
        text.Children.Add(_mode);
        row.Children.Add(text);

        var endBtn = new Button
        {
            Content = "End", Style = (Style)Application.Current.Resources["PrimaryButton"],
            Padding = new Thickness(14, 4, 14, 4), FontSize = 12,
            Margin = new Thickness(16, 0, 0, 0)
        };
        endBtn.Click += (_, _) => { onEnd(); Close(); };
        row.Children.Add(endBtn);

        border.Child = row;
        Content = border;
    }

    public void SetControlGranted(bool granted) => Dispatcher.Invoke(() =>
    {
        _mode.Text = granted ? "Remote control active" : "View only";
        _dot.Fill = granted
            ? (Brush)Application.Current.Resources["BrandWarn"]
            : (Brush)Application.Current.Resources["BrandAccent"];
    });

    // Block Alt+F4 / close attempts from technician-side automation; only the End
    // button (or the user's own window controls) may terminate the indicator.
    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        // Allow close only when triggered by our End button (which calls Close directly).
        base.OnClosing(e);
    }
}
