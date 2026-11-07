using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace ConnectLive.Agent;

/// <summary>One local disclosure, not a series of prompts or a silent grant.</summary>
internal static class PairingPrompt
{
    internal static Task<bool> ShowAsync(ApiClient api, CancellationToken applicationToken, bool startWithWindows = false,
        bool sessionEnded = false)
    {
        if (applicationToken.IsCancellationRequested) return Task.FromResult(false);
        if (!Application.Current.Dispatcher.CheckAccess())
            return Application.Current.Dispatcher.InvokeAsync(() => ShowAsync(api, applicationToken, startWithWindows, sessionEnded)).Task.Unwrap();
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(applicationToken);
        var token = cancellation.Token;
        var window = new Window
        {
            Title = "ConnectLive — pairing code", Width = 500, MinWidth = 400,
            SizeToContent = SizeToContent.Height,
            MaxHeight = Math.Max(360, SystemParameters.WorkArea.Height - 60),
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Background = (Brush)Application.Current.Resources["BrandSurface"],
            Foreground = (Brush)Application.Current.Resources["BrandInk"],
            FontFamily = (FontFamily)Application.Current.Resources["BrandFont"],
        };
        var root = new StackPanel { Margin = new Thickness(24) };
        window.Content = new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        void Text(string text, int size = 13) => root.Children.Add(new TextBlock
        {
            Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12),
        });
        root.Children.Add(new TextBlock
        {
            Text = "ConnectLive", FontSize = 24, FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Application.Current.Resources["BrandAccent"],
            Margin = new Thickness(0, 0, 0, 20),
        });
        Text(sessionEnded || SessionPairingRequirement.Required ? "Your support session has ended" : "Pair this device", 20);
        Text(sessionEnded || SessionPairingRequirement.Required
            ? "Remote access is stopped. Enter a new one-time pairing code from your administrator to start another support visit."
            : "Enter the one-time pairing code from your administrator.");
        Text($"Server: {LocalGrant.OriginOf(api.ApiBaseUrl)}", 11);
        Text("Pairing code", 12);
        var input = new TextBox
        {
            FontSize = 22, FontFamily = new FontFamily("Consolas"),
            MaxLength = 40, CharacterCasing = CharacterCasing.Upper,
            Padding = new Thickness(12), Margin = new Thickness(0, 0, 0, 12),
            Background = Brushes.White, BorderBrush = (Brush)Application.Current.Resources["BrandBorder"],
        };
        System.Windows.Automation.AutomationProperties.SetName(input, "One-time pairing code");
        root.Children.Add(input);
        var review = new Button
        {
            Content = "Continue", IsDefault = true,
            Style = (Style)Application.Current.Resources["PrimaryButton"],
        };
        root.Children.Add(review);
        var details = new StackPanel { Visibility = Visibility.Collapsed };
        root.Children.Add(details);
        var disclosure = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 12), FontSize = 13 };
        details.Children.Add(disclosure);
        var expires = new TextBlock { FontSize = 11, Margin = new Thickness(0, 0, 0, 12), TextWrapping = TextWrapping.Wrap };
        details.Children.Add(expires);
        var error = new TextBlock { Foreground = Brushes.DarkRed, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12) };
        root.Children.Add(error);
        var companionsAvailable = File.Exists(Path.Combine(AppContext.BaseDirectory, "ConnectLiveWatch.exe")) &&
            File.Exists(Path.Combine(AppContext.BaseDirectory, "ConnectLiveUpdate.exe"));
        var enableStartup = startWithWindows && companionsAvailable;
        details.Children.Add(new TextBlock
        {
            Text = enableStartup
                ? "Windows startup was requested for this launch. " + StartupConsent.Notice
                : startWithWindows
                    ? "Startup/recovery cannot be enabled because the companion apps are missing. This copy must be opened manually."
                    : "Windows startup/recovery is not enabled by this pairing.",
            FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12),
        });
        details.Children.Add(new TextBlock
        {
            Text = "Pairing accepts the administrator's access settings above. The Agent then runs in the background, without a status window or tray controls. To disable access locally, run ConnectLive.exe /disable or uninstall ConnectLive.",
            FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12),
        });
        var pair = new Button
        {
            Content = "Pair and connect", IsEnabled = false, Visibility = Visibility.Collapsed,
            Style = (Style)Application.Current.Resources["PrimaryButton"],
        };
        root.Children.Add(pair);
        var cancel = new Button
        {
            Content = "Cancel", IsCancel = true, Margin = new Thickness(0, 10, 0, 0),
            Style = (Style)Application.Current.Resources["SecondaryButton"],
        };
        root.Children.Add(cancel);

        PairingAttempt? attempt = null;
        bool busy = false, closed = false, paired = false;
        input.TextChanged += (_, _) =>
        {
            attempt = null; pair.IsEnabled = false; pair.IsDefault = false;
            pair.Visibility = Visibility.Collapsed; details.Visibility = Visibility.Collapsed;
            review.Visibility = Visibility.Visible; review.IsDefault = true;
            disclosure.Text = ""; expires.Text = ""; error.Text = "";
        };
        review.Click += async (_, _) =>
        {
            if (busy) return;
            if (string.IsNullOrWhiteSpace(input.Text))
            { error.Text = "Enter your pairing code first."; input.Focus(); return; }
            busy = true; review.IsEnabled = false; input.IsEnabled = false; pair.IsEnabled = false; error.Text = "";
            try
            {
                var offer = await api.InspectPairingAsync(input.Text.Trim(), token);
                if (closed || token.IsCancellationRequested) return;
                attempt = new PairingAttempt(input.Text.Trim(), offer);
                var allowed = new List<string> { "View screen" };
                if (offer.Capabilities.Control) allowed.Add("Keyboard/mouse control and privacy curtain");
                if (offer.Capabilities.Clipboard) allowed.Add("Clipboard text");
                if (offer.Capabilities.Files) allowed.Add("File transfer");
                if (offer.Capabilities.Recording) allowed.Add("Record shared sessions");
                disclosure.Text = $"Organization: {offer.Organization}\n\n" +
                    (offer.Mode == "unattended"
                        ? "Unattended access — this organization can connect without another session prompt, including after restart.\n\n"
                        : "Attended access — approve each session.\n\n") +
                    $"Permissions: {string.Join(", ", allowed)}.";
                expires.Text = $"Code expires at {offer.ExpiresAt.ToLocalTime():HH:mm}.";
                details.Visibility = Visibility.Visible;
                review.Visibility = Visibility.Collapsed; review.IsDefault = false;
                pair.Visibility = Visibility.Visible; pair.IsDefault = true;
                pair.IsEnabled = true;
                pair.Focus();
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { if (!closed) error.Text = ex.Message; }
            catch (OperationCanceledException) { }
            finally { busy = false; if (!closed) { review.IsEnabled = true; input.IsEnabled = true; } }
        };
        pair.Click += async (_, _) =>
        {
            if (busy || attempt == null) return;
            if (attempt.Offer.ExpiresAt <= DateTimeOffset.UtcNow)
            { error.Text = "This code expired. Ask for a new code and enter it above."; pair.IsEnabled = false; return; }
            busy = true; pair.IsEnabled = false; review.IsEnabled = false; input.IsEnabled = false;
            pair.Content = "Pairing…"; error.Text = "";
            try
            {
                await api.CompletePairingAsync(attempt, token);
                token.ThrowIfCancellationRequested();
                StartupConsent.Save(api.LocalAuthorization ?? throw new InvalidOperationException("Pairing did not record authorization"),
                    enableStartup);
                LocalAccessState.CompleteForegroundReauthorization();
                SessionPairingRequirement.CompleteForegroundPairing();
                paired = true;
                window.DialogResult = true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { if (!closed) error.Text = ex.Message; }
            catch (OperationCanceledException) { }
            finally
            {
                busy = false;
                if (!closed)
                {
                    pair.IsEnabled = attempt != null && attempt.Offer.ExpiresAt > DateTimeOffset.UtcNow;
                    pair.Content = "Pair and connect"; review.IsEnabled = true; input.IsEnabled = true;
                }
            }
        };
        window.Closed += (_, _) => { closed = true; if (!paired) cancellation.Cancel(); };
        using var registration = applicationToken.Register(() =>
            window.Dispatcher.BeginInvoke(new Action(() => { if (!closed) window.Close(); })));
        window.Loaded += (_, _) => input.Focus();
        return Task.FromResult(window.ShowDialog() == true && paired);
    }
}
