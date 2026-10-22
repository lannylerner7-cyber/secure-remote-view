using System;
using System.Windows;
using System.Windows.Controls;

namespace ConnectLive.Agent;

internal static class AuthorizationPrompt
{
    internal static (string Mode, GrantScopes Scopes)? Ask(string origin, string deviceId)
    {
        var window = new Window { Title = "ConnectLive — authorize remote access", Width = 490,
            Height = 590, WindowStartupLocation = WindowStartupLocation.CenterScreen, ResizeMode = ResizeMode.NoResize };
        var panel = new StackPanel { Margin = new Thickness(24) };
        window.Content = panel;
        panel.Children.Add(new TextBlock { Text = $"Authorize ConnectLive support for this Windows user?\nServer: {origin}\nDevice: {deviceId}\n\nView shares your screen. Control permits remote keyboard/mouse and privacy curtain. Clipboard shares text in both directions. Files permits sending and receiving files. Recording permits the technician to record shared screen content.\n\nAttended requires your acceptance for each session. Unattended permits access without a session prompt, including after restart. Close/Disable remote access withdraws locally even offline. A replacement grant ends current sessions.",
            TextWrapping = TextWrapping.Wrap });
        var attended = new RadioButton { Content = "Attended — ask for each session", Margin = new Thickness(0, 14, 0, 4), GroupName = "mode" };
        var unattended = new RadioButton { Content = "Unattended — no session prompt", GroupName = "mode" };
        panel.Children.Add(attended); panel.Children.Add(unattended);
        var choices = new CheckBox[5];
        var names = new[] { "View screen", "Control keyboard and mouse", "Clipboard text", "File exchange", "Recording" };
        for (int i = 0; i < choices.Length; i++)
        {
            choices[i] = new CheckBox { Content = names[i], Margin = new Thickness(0, 7, 0, 0), IsChecked = false };
            panel.Children.Add(choices[i]);
        }
        var agree = new Button { Content = "Agree and record authorization", Margin = new Thickness(0, 18, 0, 0), Padding = new Thickness(8) };
        panel.Children.Add(agree);
        agree.Click += (_, _) =>
        {
            if (attended.IsChecked != true && unattended.IsChecked != true ||
                choices[1].IsChecked == true && choices[0].IsChecked != true)
            {
                MessageBox.Show(window, "Choose a mode. Control requires View.", "ConnectLive");
                return;
            }
            window.DialogResult = true;
        };
        if (window.ShowDialog() != true) return null;
        return (unattended.IsChecked == true ? "unattended" : "attended",
            new(choices[0].IsChecked == true, choices[1].IsChecked == true,
                choices[2].IsChecked == true, choices[3].IsChecked == true, choices[4].IsChecked == true));
    }
}
