using System;
using System.Windows;
using System.Windows.Controls;

namespace ConnectLive.Agent;

internal static class AuthorizationPrompt
{
    // Every term the person agrees to with "Accept all". Unattended access and
    // recording are deliberately absent: they stay separate, unticked opt-ins.
    private static readonly string[] Terms =
    {
        "A technician can see your screen during a support session.",
        "A technician can use your keyboard and mouse, and can show a privacy curtain that hides your screen and pauses your own input while they work.",
        "Text you copy can be shared between you and the technician, in both directions.",
        "Files can be sent to and received from this computer.",
        "You are asked to allow every session before it starts.",
        "ConnectLive starts with Windows and stays in the system tray. Use the tray icon to review this agreement or disable remote access at any time, even offline.",
        "Accepting a new agreement replaces this one and ends any current session.",
    };

    internal static (string Mode, GrantScopes Scopes)? Ask(string origin, string deviceId)
    {
        var window = new Window { Title = "ConnectLive — authorize remote access", Width = 520,
            Height = 640, WindowStartupLocation = WindowStartupLocation.CenterScreen, ResizeMode = ResizeMode.CanResize };
        var panel = new StackPanel { Margin = new Thickness(24) };
        window.Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };

        panel.Children.Add(new TextBlock { Text = "Authorize ConnectLive remote support for this Windows user?",
            FontSize = 16, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = $"Server: {origin}\nDevice: {deviceId}",
            Margin = new Thickness(0, 6, 0, 0), Opacity = 0.75, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = "By choosing Accept all, you agree that:",
            Margin = new Thickness(0, 16, 0, 4), FontWeight = FontWeights.SemiBold });
        foreach (var term in Terms)
            panel.Children.Add(new TextBlock { Text = "•  " + term, Margin = new Thickness(6, 4, 0, 0), TextWrapping = TextWrapping.Wrap });

        panel.Children.Add(new TextBlock { Text = "Optional, off unless you tick them:",
            Margin = new Thickness(0, 16, 0, 2), FontWeight = FontWeights.SemiBold });
        var unattended = new CheckBox { Margin = new Thickness(0, 6, 0, 0), Content = new TextBlock { TextWrapping = TextWrapping.Wrap,
            Text = "Unattended access: technicians can connect without asking, including after a restart." } };
        var recording = new CheckBox { Margin = new Thickness(0, 6, 0, 0), Content = new TextBlock { TextWrapping = TextWrapping.Wrap,
            Text = "Recording: the technician can record your shared screen." } };
        panel.Children.Add(unattended);
        panel.Children.Add(recording);

        var accept = new Button { Content = "Accept all", Margin = new Thickness(0, 20, 0, 0), Padding = new Thickness(8), FontWeight = FontWeights.SemiBold };
        var decline = new Button { Content = "Decline", Margin = new Thickness(0, 8, 0, 0), Padding = new Thickness(8), IsCancel = true };
        panel.Children.Add(accept);
        panel.Children.Add(decline);

        // Per-permission choice for people who don't want everything. Starts
        // with the Accept all set so narrowing it is an explicit untick.
        var individual = new StackPanel();
        panel.Children.Add(new Expander { Header = "Customize permissions instead",
            Content = individual, IsExpanded = false, Margin = new Thickness(0, 14, 0, 0) });
        var names = new[] { "View screen", "Control keyboard and mouse", "Clipboard text", "File exchange" };
        var choices = new CheckBox[names.Length];
        for (int i = 0; i < choices.Length; i++)
        {
            choices[i] = new CheckBox { Content = names[i], Margin = new Thickness(0, 7, 0, 0), IsChecked = true };
            individual.Children.Add(choices[i]);
        }
        var allowSelected = new Button { Content = "Allow selected permissions", Margin = new Thickness(0, 12, 0, 0), Padding = new Thickness(8) };
        individual.Children.Add(allowSelected);

        GrantScopes? scopes = null;
        accept.Click += (_, _) =>
        {
            scopes = new(true, true, true, true, recording.IsChecked == true);
            window.DialogResult = true;
        };
        allowSelected.Click += (_, _) =>
        {
            if (!Array.Exists(choices, c => c.IsChecked == true) ||
                choices[1].IsChecked == true && choices[0].IsChecked != true)
            {
                MessageBox.Show(window, "Choose at least one permission. Control requires View.", "ConnectLive");
                return;
            }
            scopes = new(choices[0].IsChecked == true, choices[1].IsChecked == true,
                choices[2].IsChecked == true, choices[3].IsChecked == true, recording.IsChecked == true);
            window.DialogResult = true;
        };
        decline.Click += (_, _) => window.DialogResult = false;

        if (window.ShowDialog() != true || scopes == null) return null;
        return (unattended.IsChecked == true ? "unattended" : "attended", scopes);
    }
}
