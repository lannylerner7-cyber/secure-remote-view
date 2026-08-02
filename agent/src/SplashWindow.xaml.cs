using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace ConnectLive.Agent;

/// <summary>
/// The Agent's ONLY visible surface: a ~5s startup splash that doubles as the
/// connection banner. Shows our own branding, live status text, the device id
/// and the active session (if any), then auto-closes. Nothing else is ever
/// shown — no persistent status window, no tray, no wake pop-ups. Everything
/// after this runs silently in the background.
/// (Consent prompt and the control curtain remain separate, deliberate
/// surfaces owned by their own scopes.)
/// </summary>
public sealed class SplashWindow : Window
{
    private readonly TextBlock _status;
    private readonly TextBlock _device;
    private readonly TextBlock _session;

    public SplashWindow()
    {
        Title = "ConnectLive Agent";
        Width = 480; Height = 330;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ShowInTaskbar = false;

        var root = new Border
        {
            CornerRadius = new CornerRadius(14),
            Background = (Brush)Application.Current.Resources["BrandSurface"],
            BorderBrush = (Brush)Application.Current.Resources["BrandBorder"],
            BorderThickness = new Thickness(1),
            Effect = new System.Windows.Media.Effects.DropShadowEffect
            {
                Color = Colors.Black, Opacity = 0.18, BlurRadius = 30, ShadowDepth = 6
            }
        };

        var stack = new StackPanel { Margin = new Thickness(36, 26, 36, 26) };

        var wordmark = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 6) };
        wordmark.Children.Add(new Ellipse
        {
            Width = 14, Height = 14,
            Fill = (Brush)Application.Current.Resources["BrandAccent"],
            Margin = new Thickness(0, 6, 10, 0),
            VerticalAlignment = VerticalAlignment.Center
        });
        wordmark.Children.Add(new TextBlock
        {
            Text = "ConnectLive",
            FontSize = 28,
            FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Application.Current.Resources["BrandInk"]
        });
        stack.Children.Add(wordmark);

        stack.Children.Add(new TextBlock
        {
            Text = "Transparent remote support",
            FontSize = 13,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            Margin = new Thickness(0, 0, 0, 18)
        });

        var progress = new ProgressBar
        {
            IsIndeterminate = true,
            Height = 4,
            Foreground = (Brush)Application.Current.Resources["BrandAccent"],
            Background = (Brush)Application.Current.Resources["BrandBorder"],
            BorderThickness = new Thickness(0)
        };
        stack.Children.Add(progress);

        _status = new TextBlock
        {
            Text = "Starting…",
            FontSize = 12,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            Margin = new Thickness(0, 12, 0, 14)
        };
        stack.Children.Add(_status);

        _device = Row(stack, "Device", "—");
        _session = Row(stack, "Session", "No active session");

        stack.Children.Add(new TextBlock
        {
            Text = "You will always be asked before your screen is shared.",
            FontSize = 11,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            Margin = new Thickness(0, 14, 0, 0),
            TextWrapping = TextWrapping.Wrap
        });

        root.Child = stack;
        Content = root;
    }

    private static TextBlock Row(Panel parent, string label, string value)
    {
        var grid = new Grid { Margin = new Thickness(0, 0, 0, 6) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var l = new TextBlock
        {
            Text = label,
            FontSize = 11,
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

    public void SetStatus(string text) => Dispatcher.Invoke(() => _status.Text = text);
    public void SetDevice(string text) => Dispatcher.Invoke(() => _device.Text = text);
    public void SetSession(string text) => Dispatcher.Invoke(() => _session.Text = text);
}
