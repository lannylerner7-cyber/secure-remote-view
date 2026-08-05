using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace ConnectLive.Agent;

/// <summary>
/// First-run Meeting-ID prompt. The customer received this ID when their
/// license was minted (payments console → Customers → license). One license
/// covers N seats; every device on that account enrolls with the same ID.
///
/// Rendered as a small, branded modal that matches the SplashWindow visual
/// language. Shown only on foreground launches — a headless /BACKGROUND or
/// /WAKE start never surfaces UI, so those launches simply skip enrollment
/// until a foreground run supplies the ID.
/// </summary>
public sealed class MeetingIdPrompt : Window
{
    private readonly TextBox _input;
    private readonly TextBlock _error;
    private string? _result;

    public MeetingIdPrompt(string? errorMessage = null)
    {
        Title = "ConnectLive — Meeting ID";
        Width = 460; Height = 320;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ShowInTaskbar = true;
        Topmost = true;

        var root = new Border
        {
            CornerRadius = new CornerRadius(14),
            Background = (Brush)Application.Current.Resources["BrandSurface"],
            BorderBrush = (Brush)Application.Current.Resources["BrandBorder"],
            BorderThickness = new Thickness(1),
        };

        var stack = new StackPanel { Margin = new Thickness(32, 26, 32, 22) };

        stack.Children.Add(new TextBlock
        {
            Text = "Enter your Meeting ID",
            FontSize = 20,
            FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Application.Current.Resources["BrandInk"],
            Margin = new Thickness(0, 0, 0, 6),
        });
        stack.Children.Add(new TextBlock
        {
            Text = "The ID was emailed to your account contact when your license was created. One ID covers every device on your plan.",
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            Foreground = (Brush)Application.Current.Resources["BrandMuted"],
            Margin = new Thickness(0, 0, 0, 16),
        });

        _input = new TextBox
        {
            FontSize = 18,
            FontFamily = new FontFamily("Consolas, Menlo, monospace"),
            Padding = new Thickness(10, 8, 10, 8),
            CharacterCasing = CharacterCasing.Upper,
            MaxLength = 16,
        };
        _input.KeyDown += (_, e) =>
        {
            if (e.Key == Key.Enter) Accept();
            if (e.Key == Key.Escape) { _result = null; Close(); }
        };
        stack.Children.Add(_input);

        _error = new TextBlock
        {
            FontSize = 12,
            Foreground = Brushes.IndianRed,
            Margin = new Thickness(0, 8, 0, 0),
            TextWrapping = TextWrapping.Wrap,
            Text = errorMessage ?? "",
            Visibility = string.IsNullOrEmpty(errorMessage) ? Visibility.Collapsed : Visibility.Visible,
        };
        stack.Children.Add(_error);

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 18, 0, 0),
        };
        var cancel = new Button
        {
            Content = "Cancel",
            Padding = new Thickness(14, 6, 14, 6),
            Margin = new Thickness(0, 0, 8, 0),
            Background = Brushes.Transparent,
            BorderBrush = (Brush)Application.Current.Resources["BrandBorder"],
            Foreground = (Brush)Application.Current.Resources["BrandInk"],
        };
        cancel.Click += (_, _) => { _result = null; Close(); };
        var ok = new Button
        {
            Content = "Continue",
            Padding = new Thickness(18, 6, 18, 6),
            Background = (Brush)Application.Current.Resources["BrandAccent"],
            Foreground = Brushes.White,
            BorderThickness = new Thickness(0),
            IsDefault = true,
        };
        ok.Click += (_, _) => Accept();
        buttons.Children.Add(cancel);
        buttons.Children.Add(ok);
        stack.Children.Add(buttons);

        root.Child = stack;
        Content = root;
        Loaded += (_, _) => _input.Focus();
    }

    private void Accept()
    {
        var v = (_input.Text ?? "").Trim();
        if (v.Length < 4) { ShowError("Please enter your Meeting ID."); return; }
        _result = v;
        Close();
    }

    private void ShowError(string msg)
    {
        _error.Text = msg;
        _error.Visibility = Visibility.Visible;
    }

    /// <summary>
    /// Blocks on the WPF dispatcher and returns the entered Meeting ID, or
    /// null if the user cancelled. Safe to call from any thread.
    /// </summary>
    public static string? Ask(string? errorMessage = null)
    {
        var app = Application.Current;
        if (app is null) return null;
        return app.Dispatcher.Invoke(() =>
        {
            var w = new MeetingIdPrompt(errorMessage);
            w.ShowDialog();
            return w._result;
        });
    }
}
