using System.Windows;
using System.Windows.Controls;

namespace ConnectLive.Agent;

internal static class AuthorizationPrompt
{
    // The whole agreement, shown on one page. Accepting grants exactly these
    // four permissions in attended mode; there is no other choice to make.
    private static readonly string[] Terms =
    {
        "Screen view: a technician can see your screen during a support session.",
        "Remote control: a technician can use your keyboard and mouse, and can show a privacy curtain that hides your screen and pauses your own input while they work.",
        "Clipboard: text you copy can be shared between you and the technician, in both directions.",
        "File transfer: files can be sent to and received from this computer.",
        "You are asked to allow every session before it starts. Nobody can connect without your approval.",
        "ConnectLive starts with Windows and stays in the system tray. Use the tray icon to review this agreement or disable remote access at any time, even offline.",
        "Accepting this agreement again replaces it and ends any current session.",
    };

    internal static (string Mode, GrantScopes Scopes)? Ask(string origin, string deviceId)
    {
        var window = new Window { Title = "ConnectLive — terms and conditions", Width = 540,
            Height = 620, WindowStartupLocation = WindowStartupLocation.CenterScreen, ResizeMode = ResizeMode.CanResize };
        var panel = new StackPanel { Margin = new Thickness(24) };
        window.Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };

        panel.Children.Add(new TextBlock { Text = "ConnectLive remote support — terms and conditions",
            FontSize = 16, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = $"Server: {origin}\nDevice: {deviceId}",
            Margin = new Thickness(0, 6, 0, 0), Opacity = 0.75, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = "Please read before continuing. If you accept, this Windows user agrees that:",
            Margin = new Thickness(0, 16, 0, 4), TextWrapping = TextWrapping.Wrap });
        foreach (var term in Terms)
            panel.Children.Add(new TextBlock { Text = "•  " + term, Margin = new Thickness(6, 6, 0, 0), TextWrapping = TextWrapping.Wrap });

        var read = new CheckBox { Margin = new Thickness(0, 20, 0, 0), Content = new TextBlock { TextWrapping = TextWrapping.Wrap,
            Text = "I have read and agree to these terms." } };
        var accept = new Button { Content = "Accept", Margin = new Thickness(0, 14, 0, 0), Padding = new Thickness(8),
            FontWeight = FontWeights.SemiBold, IsEnabled = false };
        var decline = new Button { Content = "Decline", Margin = new Thickness(0, 8, 0, 0), Padding = new Thickness(8), IsCancel = true };
        panel.Children.Add(read);
        panel.Children.Add(accept);
        panel.Children.Add(decline);

        read.Checked += (_, _) => accept.IsEnabled = true;
        read.Unchecked += (_, _) => accept.IsEnabled = false;
        accept.Click += (_, _) => { if (read.IsChecked == true) window.DialogResult = true; };
        decline.Click += (_, _) => window.DialogResult = false;

        // Decline, Esc or closing the window all return null, which the
        // caller treats as withdrawal (DisableRemoteAccess, no autostart).
        if (window.ShowDialog() != true || read.IsChecked != true) return null;
        return ("attended", new GrantScopes(View: true, Control: true, Clipboard: true, Files: true, Recording: false));
    }
}
