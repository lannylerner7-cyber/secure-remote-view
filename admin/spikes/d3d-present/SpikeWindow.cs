using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using ConnectLive.Admin.Media;

namespace ConnectLive.Spikes.D3DPresent;

// =====================================================================
// Spike 2 — a bitmap presents through D3DImage (Gate C)
//
//   dotnet run --project admin/spikes/d3d-present
//
// Gate is green when:
//   * the orange/steel test card is on screen (not black, not stripes —
//     stripes here would mean the surface pitch is being ignored),
//   * "Force device loss" makes it recover and keep animating,
//   * devices=1 stays at 1 after Park -> resume x3 (contract G3: no
//     per-session device churn),
//   * no crash, no leaked surfaces (surfaces only rise on resize).
// =====================================================================

public static class SpikeApp
{
    [STAThread]
    public static void Main()
    {
        var app = new Application();
        app.Run(new SpikeWindow());
    }
}

public sealed class SpikeWindow : Window
{
    private readonly D3DImageHost _host = new();
    private readonly Image _view = new() { Stretch = Stretch.Uniform };
    private readonly TextBlock _status = new() { Margin = new Thickness(8), FontFamily = new FontFamily("Consolas") };
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(33) };

    private int _w = 1280, _h = 720;
    private byte[] _bgra = Array.Empty<byte>();
    private int _tick, _presented, _failed;

    public SpikeWindow()
    {
        Title = "ConnectLive — Gate C: D3DImage present spike";
        Width = 1000; Height = 700;
        Background = Brushes.Black;

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8) };
        buttons.Children.Add(Button("Force device loss", (_, __) => _host.SimulateDeviceLossForTest()));
        buttons.Children.Add(Button("Park (end session)", (_, __) => _host.Park()));
        buttons.Children.Add(Button("Resize source 1280<->1920", (_, __) =>
        {
            _w = _w == 1280 ? 1920 : 1280;
            _h = _h == 720 ? 1080 : 720;
            _bgra = Array.Empty<byte>();
        }));

        var root = new DockPanel();
        DockPanel.SetDock(buttons, Dock.Top);
        DockPanel.SetDock(_status, Dock.Bottom);
        root.Children.Add(buttons);
        root.Children.Add(_status);
        root.Children.Add(_view);
        Content = root;

        _view.Source = _host.Image;
        _timer.Tick += OnTick;
        _timer.Start();
        Closed += (_, __) => { _timer.Stop(); _host.Dispose(); };
    }

    private static Button Button(string text, RoutedEventHandler onClick)
    {
        var b = new Button { Content = text, Margin = new Thickness(0, 0, 8, 0), Padding = new Thickness(10, 4, 10, 4) };
        b.Click += onClick;
        return b;
    }

    private void OnTick(object? sender, EventArgs e)
    {
        _tick++;
        RenderCard();
        if (_host.PushBgra(_bgra, _w, _h)) _presented++; else _failed++;
        if (_view.Source != _host.Image) _view.Source = _host.Image;

        _status.Text = $"{_w}x{_h}  presented={_presented}  push-failed={_failed}  " +
                       $"devices={_host.DeviceCreations}  surfaces={_host.SurfaceAllocations}  " +
                       $"available={_host.Available}";
        _status.Foreground = _host.Available ? Brushes.LightGreen : Brushes.OrangeRed;
    }

    /// <summary>
    /// Static test card + one moving bar. The card is deliberately ORANGE:
    /// if the surface path swaps R and B it shows up as blue instantly, and if
    /// the pitch is ignored the vertical edges shear.
    /// </summary>
    private void RenderCard()
    {
        if (_bgra.Length != _w * _h * 4) _bgra = new byte[_w * _h * 4];
        int barX = (_tick * 9) % _w;
        for (int y = 0; y < _h; y++)
        {
            int row = y * _w * 4;
            bool band = (y / 60) % 2 == 0;
            for (int x = 0; x < _w; x++)
            {
                int i = row + x * 4;
                bool bar = x >= barX && x < barX + 24;
                byte b, g, r;
                if (bar) { b = 255; g = 255; r = 255; }
                else if (band) { b = 20; g = 120; r = 240; }   // orange  (BGRA order)
                else { b = 60; g = 48; r = 40; }               // steel
                _bgra[i] = b; _bgra[i + 1] = g; _bgra[i + 2] = r; _bgra[i + 3] = 255;
            }
        }
    }
}
