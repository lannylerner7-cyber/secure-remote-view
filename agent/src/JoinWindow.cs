using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace ConnectLive.Agent;

/// <summary>
/// The Join window is the first thing the user sees after enrollment.
/// They enter the 6-digit code that the admin generated in the panel.
/// On success we hand control back to the Agent to start heartbeats +
/// the live-session banner.
/// </summary>
public sealed class JoinWindow : Window
{
    private readonly ApiClient _api;
    private readonly TextBox _codeInput;
    private readonly TextBlock _status;
    private readonly Button _join;
    public string? JoinedSessionId { get; private set; }

    public JoinWindow(ApiClient api)
    {
        _api = api;
        Title = "ConnectLive — Join";
        Width = 420; Height = 320;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        ResizeMode = ResizeMode.NoResize;
        Background = new SolidColorBrush(Color.FromRgb(0x0F, 0x17, 0x2A));
        Foreground = Brushes.White;

        var root = new StackPanel { Margin = new Thickness(28) };

        root.Children.Add(new TextBlock
        {
            Text = "ConnectLive",
            FontSize = 18, FontWeight = FontWeights.SemiBold,
            Foreground = new SolidColorBrush(Color.FromRgb(0x4F, 0x7C, 0xFF)),
            Margin = new Thickness(0, 0, 0, 18),
        });

        root.Children.Add(new TextBlock
        {
            Text = "Enter meeting code",
            FontSize = 20, FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 6),
        });
        root.Children.Add(new TextBlock
        {
            Text = "Ask your helpdesk for the 6-digit code shown in their admin panel.",
            FontSize = 12, Opacity = 0.7,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 16),
        });

        _codeInput = new TextBox
        {
            FontSize = 22, FontFamily = new FontFamily("Consolas"),
            MaxLength = 6, TextAlignment = TextAlignment.Center,
            Padding = new Thickness(8), Height = 44,
            Background = new SolidColorBrush(Color.FromArgb(0x66, 0, 0, 0)),
            Foreground = Brushes.White,
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF)),
        };
        _codeInput.PreviewTextInput += (_, ev) => { foreach (var c in ev.Text) if (c < '0' || c > '9') { ev.Handled = true; return; } };
        _codeInput.KeyDown += (_, ev) => { if (ev.Key == System.Windows.Input.Key.Enter) _ = Submit(); };
        root.Children.Add(_codeInput);

        _status = new TextBlock { FontSize = 12, Opacity = 0.75, Margin = new Thickness(0, 10, 0, 10) };
        root.Children.Add(_status);

        _join = new Button
        {
            Content = "Join",
            Height = 40, FontWeight = FontWeights.SemiBold,
            Background = new SolidColorBrush(Color.FromRgb(0x4F, 0x7C, 0xFF)),
            Foreground = Brushes.White, BorderThickness = new Thickness(0),
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        _join.Click += async (_, __) => await Submit();
        root.Children.Add(_join);

        Content = root;
        Loaded += (_, __) => _codeInput.Focus();
    }

    private async Task Submit()
    {
        var code = (_codeInput.Text ?? "").Trim();
        if (code.Length != 6) { _status.Text = "Enter a 6-digit code."; return; }

        _join.IsEnabled = false;
        _status.Text = "Joining…";
        try
        {
            var res = await _api.PairAsync(code, CancellationToken.None);
            if (res.Ok)
            {
                JoinedSessionId = res.SessionId;
                _status.Text = "Connected. Starting session…";
                await Task.Delay(400);
                DialogResult = true;
                Close();
            }
            else
            {
                _status.Text = res.Error switch
                {
                    "not_found" => "That code isn't active. Ask your helpdesk to generate a fresh one.",
                    "code_in_use" => "That code is already linked to a different PC.",
                    "invalid_code" => "Enter a 6-digit code.",
                    _ => $"Couldn't join: {res.Error}",
                };
                _join.IsEnabled = true;
            }
        }
        catch (Exception ex)
        {
            _status.Text = $"Network error: {ex.Message}";
            _join.IsEnabled = true;
        }
    }
}
