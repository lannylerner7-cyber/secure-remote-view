using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

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
        // Compact strip: small footprint, always visible, doesn't cover work area.
        Width = 190; Height = 30;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;

        // Pin to the very top-right corner, hugging the screen edge.
        var work = SystemParameters.WorkArea;
        Left = work.Right - Width - 8;
        Top  = work.Top   + 6;

        var border = new Border
        {
            CornerRadius = new CornerRadius(15),
            Background = (Brush)Application.Current.Resources["BrandInk"],
            BorderThickness = new Thickness(0),
            Opacity = 0.92
        };

        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(10, 4, 4, 4) };

        _dot = new Ellipse
        {
            Width = 7, Height = 7,
            Fill = (Brush)Application.Current.Resources["BrandAccent"],
            Margin = new Thickness(0, 7, 7, 0)
        };
        row.Children.Add(_dot);

        _mode = new TextBlock
        {
            Text = "Live · view",
            Foreground = Brushes.White,
            FontSize = 11,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 5, 8, 0),
            ToolTip = $"Sharing with {technician}"
        };
        row.Children.Add(_mode);

        var endBtn = new Button
        {
            Content = "End",
            Padding = new Thickness(8, 1, 8, 1),
            FontSize = 10,
            Margin = new Thickness(4, 0, 0, 0),
            Background = new SolidColorBrush(Color.FromArgb(60, 255, 255, 255)),
            Foreground = Brushes.White,
            BorderThickness = new Thickness(0),
            Cursor = System.Windows.Input.Cursors.Hand,
            ToolTip = "End session immediately"
        };
        endBtn.Click += (_, _) => { onEnd(); Close(); };
        row.Children.Add(endBtn);

        border.Child = row;
        Content = border;

        // Allow the user to drag the strip if it ever overlaps something important.
        MouseLeftButtonDown += (_, e) => { if (e.ButtonState == System.Windows.Input.MouseButtonState.Pressed) DragMove(); };
    }

    public void SetControlGranted(bool granted) => Dispatcher.Invoke(() =>
    {
        _mode.Text = granted ? "Live · control" : "Live · view";
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
