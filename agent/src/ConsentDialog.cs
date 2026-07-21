using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace ConnectLive.Agent;

/// <summary>
/// Modal consent dialogs. Two flavors — screen-sharing (view) and remote control.
/// Both default to DENY. No auto-accept. No timeout that auto-approves.
/// </summary>
public static class ConsentDialog
{
    public static bool AskViewConsent(string technician) => Ask(
        title: "Screen sharing request",
        headline: $"{technician} is asking to view your screen.",
        detail: "Nothing is shared until you click Allow. You can end the session at any time from the tray.",
        allowLabel: "Allow view");

    public static bool AskControlConsent() => Ask(
        title: "Remote control request",
        headline: "The helpdesk is asking to control your mouse and keyboard.",
        detail: "This is a separate permission from screen sharing. You can revoke it at any time.",
        allowLabel: "Allow control");

    private static bool Ask(string title, string headline, string detail, string allowLabel)
    {
        var win = new Window
        {
            Title = title,
            Width = 460, Height = 240,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            ResizeMode = ResizeMode.NoResize,
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true
        };

        var border = new Border
        {
            CornerRadius = new CornerRadius(12),
            Background = Brushes.White,
            BorderBrush = (Brush)Application.Current.Resources["BrandBorder"],
            BorderThickness = new Thickness(1)
        };

        var stack = new StackPanel { Margin = new Thickness(28, 24, 28, 20) };
        stack.Children.Add(new TextBlock
        {
            Text = headline, FontSize = 16, FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Application.Current.Resources["BrandInk"],
            TextWrapping = TextWrapping.Wrap
        });
        stack.Children.Add(new TextBlock
        {
            Text = detail, FontSize = 12, Margin = new Thickness(0, 10, 0, 0),
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            TextWrapping = TextWrapping.Wrap
        });

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 24, 0, 0)
        };
        bool result = false;

        var deny = new Button
        {
            Content = "Deny",
            Style = (Style)Application.Current.Resources["SecondaryButton"],
            Margin = new Thickness(0, 0, 8, 0)
        };
        deny.Click += (_, _) => { result = false; win.Close(); };

        var allow = new Button
        {
            Content = allowLabel,
            Style = (Style)Application.Current.Resources["PrimaryButton"]
        };
        allow.Click += (_, _) => { result = true; win.Close(); };

        buttons.Children.Add(deny);
        buttons.Children.Add(allow);
        stack.Children.Add(buttons);

        border.Child = stack;
        win.Content = border;
        win.ShowDialog();
        return result;
    }
}
