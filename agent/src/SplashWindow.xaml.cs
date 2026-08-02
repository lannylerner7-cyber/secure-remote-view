using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace ConnectLive.Agent;

/// <summary>
/// The Agent's ONLY visible surface: a ~5s startup splash showing our own
/// branding, the live connection banner (link state, device id, session).
/// It auto-closes and nothing else is ever shown — no status window, no tray,
/// no wake pop-ups. Everything after this runs silently in the background.
/// (Consent prompt and the control curtain are separate, deliberate surfaces.)
/// </summary>
public sealed class SplashWindow : Window
{
    private readonly TextBlock _status;
    private readonly TextBlock _link;
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
            Margin = new Thickness(0, 0, 0, 20)
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
            Margin = new Thickness(0, 12, 0, 16