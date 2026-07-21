using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace ConnectLive.Agent;

/// <summary>
/// The Join window is the first thing the user sees after enrollment.
/// Scrollable body + sticky footer so the Join button is always visible,
/// even on low-DPI displays where the window height gets clipped.
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
        Width = 420; Height = 420;
        MinWidth = 380; MinHeight = 360;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        ResizeMode = ResizeMode.CanResize;
        Background = new SolidColorBrush(Color.FromRgb(0x0F, 0x17, 0x2A));
        Foreground = Brushes.White;

        var root = new DockPanel { LastChildFill = true };

        // ---- Sticky footer (Join button) --------------------------------
        var footer = new Border
        {
            BorderThickness = new Thickness(0, 1, 0, 0),
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x22, 0xFF, 0xFF, 0xFF)),
            Background = new SolidColorBrush(Color.FromRgb(0x0B, 0x12, 0x22)),
            Padding = new Thickness(24, 14, 24, 16),
        };
        _join = new Button
        {
            Content = "Join session",
            Height = 42, FontWeight = FontWeights.SemiBold, FontSize = 14,
            Background = new SolidColorBrush(Color.FromRgb(0x4F, 0x7C, 0xFF)),
            Foreground = Brushes.White, BorderThickness = new Thickness(0),
            Cursor = System.Windows.Input.Cursors.Hand,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        _join.Click += async (_, __) => await Submit();
        footer.Child = _join;
        DockPanel.SetDock(footer, Dock.Bottom);
        root.Children.Add(footer);

        // ---- Scrollable body -------------------------------------------
        var scroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Padding = new Thickness(24, 24, 24, 12),
        };
        var body = new StackPanel();

        var badge = new Grid { Width = 44, Height = 44, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 14) };
        badge.Children.Add(new Ellipse { Width = 44, Height = 44, Fill = new SolidColorBrush(Color.FromRgb(0x4F, 0x7C, 0xFF)) });
        badge.Children.Add(new Ellipse { Width = 12, Height = 12, Fill = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
        body.Children.Add(badge);

        body.Children.Add(new TextBlock
        {
            Text = "ConnectLive",
            FontSize = 12, FontWeight = FontWeights.SemiBold, Opacity = 0.7,
            Foreground = new SolidColorBrush(Color.FromRgb(0xB9, 0xCC, 0xFF)),
            Margin = new Thickness(0, 0, 0, 4),
        });
        body.Children.Add(new TextBlock
        {
            Text = "Enter session code",
            FontSize = 20, FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 6),
        });
        body.Children.Add(new TextBlock
        {
            Text = "Type the 6-digit code shown in your organisation's ConnectLive dashboard to start the session.",
            FontSize = 12, Opacity = 0.7, TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 16),
        });

        _codeInput = new TextBox
        {
            FontSize = 22, FontFamily = new FontFamily("Consolas"),
            MaxLength = 6, TextAlignment = TextAlignment.Center,
            Padding = new Thickness(8), Height = 46,
            Background = new SolidColorBrush(Color.FromArgb(0x66, 0, 0, 0)),
            Foreground = Brushes.White, CaretBrush = Brushes.White,
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF)),
        };
        _codeInput.PreviewTextInput += (_, ev) => { foreach (var c in ev.Text) if (c < '0' || c > '9') { ev.Handled = true; return; } };
        _codeInput.KeyDown += (_, ev) => { if (ev.Key == System.Windows.Input.Key.Enter) _ = Submit(); };
        body.Children.Add(_codeInput);

        _status = new TextBlock { FontSize = 12, Opacity = 0.75, Margin = new Thickness(0, 10, 0, 4), MinHeight = 16, TextWrapping = TextWrapping.Wrap };
        body.Children.Add(_status);

        scroll.Content = body;
        root.Children.Add(scroll);

        Content = root;
        Loaded += (_, __) => _codeInput.Focus();
    }

    private async Task Submit()
    {
        var code = (_codeInput.Text ?? "").Trim();
        if (code.Length != 6) { _status.Text = "Enter the 6-digit code."; return; }

        _join.IsEnabled = false;
        _status.Text = "Joining…";
        try
        {
            var res = await _api.PairAsync(code, CancellationToken.None);
            if (res.Ok)
            {
                JoinedSessionId = res.SessionId;
                _status.Text = "Connected. Starting session…";
                await Task.Delay(300);
                DialogResult = true;
                Close();
            }
            else
            {
                _status.Text = res.Error switch
                {
                    "not_found" => "That code isn't active. Generate a fresh one from the dashboard.",
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
