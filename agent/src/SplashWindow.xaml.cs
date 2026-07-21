using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace ConnectLive.Agent;

/// <summary>
/// Startup splash. Own branding only — no third-party logos.
/// Wordmark on top, indeterminate progress bar below, live status text.
/// Auto-closes when the agent is registered and connected.
/// </summary>
public sealed class SplashWindow : Window
{
    private readonly TextBlock _status;

    public SplashWindow()
    {
        Title = "ConnectLive Agent";
        Width = 480; Height = 280;
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

        var stack = new StackPanel { Margin = new Thickness(36, 30, 36, 30) };

        // Wordmark: ConnectLive
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
            Margin = new Thickness(0, 0, 0, 28)
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
            Margin = new Thickness(0, 14, 0, 0)
        };
        stack.Children.Add(_status);

        stack.Children.Add(new TextBlock
        {
            Text = "You will always be asked before your screen is shared.",
            FontSize = 11,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            Margin = new Thickness(0, 18, 0, 0),
            TextWrapping = TextWrapping.Wrap
        });

        root.Child = stack;
        Content = root;
    }

    public void SetStatus(string text) => Dispatcher.Invoke(() => _status.Text = text);
}
