using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace ConnectLive.Agent;

/// <summary>One local disclosure, not a series of prompts or a silent grant.</summary>
internal static class PairingPrompt
{
    internal static Task<bool> ShowAsync(ApiClient api, CancellationToken applicationToken)
    {
        if (!Application.Current.Dispatcher.CheckAccess())
            return Application.Current.Dispatcher.InvokeAsync(() => ShowAsync(api, applicationToken)).Task.Unwrap();
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(applicationToken);
        var token = cancellation.Token;
        var window = new Window
        {
            Title = "ConnectLive — pair this device", Width = 520, Height = 660,
            MinWidth = 420, MinHeight = 500, WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Background = Brushes.White, Foreground = Brushes.Black,
        };
        var root = new StackPanel { Margin = new Thickness(24) };
        window.Content = new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        void Text(string text, int size = 13) => root.Children.Add(new TextBlock
        {
            Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12),
        });
        Text("Pair this Windows device", 22);
        Text($"Server: {api.ApiBaseUrl}");
        Text("Enter the one-time code from your administrator. Review the organization and permissions before activating remote access.");
        var input = new TextBox { FontSize = 20, MaxLength = 40, Padding = new Thickness(8), Margin = new Thickness(0, 0, 0, 12) };
        System.Windows.Automation.AutomationProperties.SetName(input, "One-time pairing code");
        root.Children.Add(input);
        var review = new Button { Content = "Review pairing", Padding = new Thickness(12, 8, 12, 8), IsDefault = true };
        root.Children.Add(review);
        var disclosure = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 18, 0, 12) };
        root.Children.Add(disclosure);
        var error = new TextBlock { Foreground = Brushes.DarkRed, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) };
        root.Children.Add(error);
        var startup = new CheckBox
        {
            IsChecked = false, Margin = new Thickness(0, 0, 0, 14),
            Content = new TextBlock { Text = StartupConsent.Notice, TextWrapping = TextWrapping.Wrap },
        };
        root.Children.Add(startup);
        var pair = new Button { Content = "Pair & authorize", IsEnabled = false, Padding = new Thickness(12, 8, 12, 8), Margin = new Thickness(0, 0, 0, 10) };
        root.Children.Add(pair);
        var cancel = new Button { Content = "Cancel — do not activate", IsCancel = true, Padding = new Thickness(12, 8, 12, 8) };
        root.Children.Add(cancel);

        PairingAttempt? attempt = null;
        bool busy = false, closed = false, paired = false;
        input.TextChanged += (_, _) => { attempt = null; pair.IsEnabled = false; disclosure.Text = ""; error.Text = ""; };
        review.Click += async (_, _) =>
        {
            if (busy) return;
            busy = true; review.IsEnabled = false; input.IsEnabled = false; pair.IsEnabled = false; error.Text = "";
            try
            {
                var offer = await api.InspectPairingAsync(input.Text.Trim(), token);
                if (closed || token.IsCancellationRequested) return;
                attempt = new PairingAttempt(input.Text.Trim(), offer);
                var allowed = new List<string> { "View screen" };
                if (offer.Capabilities.Control) allowed.Add("Keyboard/mouse control (includes privacy curtain in legacy clients)");
                if (offer.Capabilities.Clipboard) allowed.Add("Clipboard text");
                if (offer.Capabilities.Files) allowed.Add("File transfer");
                if (offer.Capabilities.Recording) allowed.Add("Record shared sessions");
                disclosure.Text = $"Organization: {offer.Organization}\n\nAllowed: {string.Join(", ", allowed)}.\n\n" +
                    (offer.Mode == "unattended"
                        ? "Unattended access: this organization can connect without another session prompt, including after restart.\n\n"
                        : "Attended access: you must accept each session.\n\n") +
                    "ConnectLive status remains available in the system tray. Use Disable remote access to stop sharing and revoke access, even while offline.\n\n" +
                    $"Code expires at {offer.ExpiresAt.ToLocalTime():HH:mm}. Pair & authorize records these permissions.";
                pair.IsEnabled = true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { if (!closed) error.Text = ex.Message; }
            catch (OperationCanceledException) { }
            finally { busy = false; if (!closed) { review.IsEnabled = true; input.IsEnabled = true; } }
        };
        pair.Click += async (_, _) =>
        {
            if (busy || attempt == null) return;
            if (attempt.Offer.ExpiresAt <= DateTimeOffset.UtcNow)
            { error.Text = "This code expired. Ask for a new code and review it."; pair.IsEnabled = false; return; }
            busy = true; pair.IsEnabled = false; review.IsEnabled = false; input.IsEnabled = false; error.Text = "";
            try
            {
                await api.CompletePairingAsync(attempt, token);
                token.ThrowIfCancellationRequested();
                StartupConsent.Save(api.LocalAuthorization ?? throw new InvalidOperationException("Pairing did not record authorization"),
                    startup.IsChecked == true);
                LocalAccessState.CompleteForegroundReauthorization();
                paired = true;
                window.DialogResult = true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { if (!closed) error.Text = ex.Message; }
            catch (OperationCanceledException) { }
            finally
            {
                busy = false;
                if (!closed) { pair.IsEnabled = attempt != null; review.IsEnabled = true; input.IsEnabled = true; }
            }
        };
        window.Closed += (_, _) => { closed = true; if (!paired) cancellation.Cancel(); };
        using var registration = applicationToken.Register(() =>
            window.Dispatcher.BeginInvoke(new Action(() => { if (!closed) window.Close(); })));
        window.Loaded += (_, _) => input.Focus();
        return Task.FromResult(window.ShowDialog() == true && paired);
    }
}
