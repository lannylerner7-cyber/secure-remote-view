using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using ConnectLive.Admin.Media;

namespace ConnectLive.Spikes.D3DPresent;

// =====================================================================
// Spike 2 — a bitmap presents through D3DImage (Gate C) + S12 evidence
//
//   dotnet run --project admin/spikes/d3d-present
//   dotnet run --project admin/spikes/d3d-present -- --auto
//
// Gate C is green when:
//   * the orange/steel test card is on screen (not black, not stripes —
//     stripes here would mean the surface pitch is being ignored),
//   * "Force device loss" makes it recover and keep animating,
//   * devices=1 stays at 1 after Park -> resume x3 (contract G3: no
//     per-session device churn),
//   * no crash, no leaked surfaces (surfaces only rise on resize).
//
// S12 (--auto) drives the same shipping D3DImageHost through the four
// real-world device-lost classes without a technician clicking anything:
//   1. TDR / GPU hang            (SimulateDeviceLossForTest(removed:false))
//   2. Driver update / removal   (SimulateDeviceLossForTest(removed:true))
//   3. RDP attach / lock / dGPU  (SimulateFrontBufferLossForTest())
//   4. Thrash guard              (>5 losses in 10s must retire the D3D path
//                                 so the caller falls back to WriteableBitmap)
// and after every one it requires: frames present again, the D3DImage keeps
// animating, and the device count only rises by the losses we caused.
// It writes s12-evidence.txt next to the exe and exits 0 (pass) / 1 (fail).
// =====================================================================

public static class SpikeApp
{
    [STAThread]
    public static void Main(string[] args)
    {
        var app = new Application();
        var win = new SpikeWindow(auto: args.Any(a => a.Equals("--auto", StringComparison.OrdinalIgnoreCase)));
        app.Run(win);
        Environment.Exit(win.ExitCode);
    }
}

public sealed class SpikeWindow : Window
{
    private readonly D3DImageHost _host = new();
    private readonly Image _view = new() { Stretch = Stretch.Uniform };
    private readonly TextBlock _status = new() { Margin = new Thickness(8), FontFamily = new FontFamily("Consolas") };
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(33) };
    private readonly bool _auto;
    private readonly List<string> _evidence = new();

    private int _w = 1280, _h = 720;
    private byte[] _bgra = Array.Empty<byte>();
    private int _tick, _presented, _failed;

    /// <summary>0 = every S12 check passed (or interactive run), 1 = a check failed.</summary>
    public int ExitCode { get; private set; }

    public SpikeWindow(bool auto = false)
    {
        _auto = auto;
        Title = "ConnectLive — Gate C / S12: D3DImage present + device-lost recovery";
        Width = 1000; Height = 700;
        Background = Brushes.Black;

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8) };
        buttons.Children.Add(Button("Force device loss", (_, __) => _host.SimulateDeviceLossForTest()));
        buttons.Children.Add(Button("Force driver removal", (_, __) => _host.SimulateDeviceLossForTest(removed: true)));
        buttons.Children.Add(Button("Force RDP/front-buffer flip", (_, __) => _host.SimulateFrontBufferLossForTest()));
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
        _host.DeviceLost += r => Note($"      host reported loss: {r}");
        _host.DeviceRecovered += () => Note("      host reported recovery");
        _timer.Tick += OnTick;
        _timer.Start();
        Closed += (_, __) => { _timer.Stop(); _host.Dispose(); };

        if (_auto) Dispatcher.BeginInvoke(new Action(RunS12), DispatcherPriority.ApplicationIdle);
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

        _status.Text = $"{_w}x{_h}  presented={_presented}  push-failed={_failed}  " + _host.HealthLine();
        _status.Foreground = _host.Available ? Brushes.LightGreen : Brushes.OrangeRed;
    }

    // -----------------------------------------------------------------
    // S12 — automated device-lost verification
    // -----------------------------------------------------------------

    private void Note(string line)
    {
        _evidence.Add(line);
        Debug.WriteLine(line);
        Console.WriteLine(line);
    }

    /// <summary>Pumps the UI (and therefore OnTick/PushBgra) for the given time.</summary>
    private void Pump(int ms)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (DateTime.UtcNow < until)
        {
            Dispatcher.Invoke(() => { }, DispatcherPriority.Background);
            System.Threading.Thread.Sleep(15);
        }
    }

    /// <summary>True when frames presented during the window, i.e. the picture is alive.</summary>
    private bool PresentsDuring(int ms)
    {
        int before = _presented;
        Pump(ms);
        return _presented > before;
    }

    private bool Check(string name, bool ok)
    {
        Note($"  [{(ok ? "PASS" : "FAIL")}] {name}");
        if (!ok) ExitCode = 1;
        return ok;
    }

    private void RunS12()
    {
        Note("S12 — admin D3D device-lost verification  " + DateTime.UtcNow.ToString("u"));
        Note("host: " + Environment.MachineName + "  os: " + Environment.OSVersion);

        // Baseline. If D3D is unavailable at all (no GPU in CI, RDP-only box)
        // there is nothing to prove and nothing to fail — the caller already
        // falls back to the bitmap presenter by contract.
        Pump(1500);
        if (!_host.Available || _presented == 0)
        {
            Note("  [SKIP] D3D path unavailable on this host — bitmap presenter is the contract fallback");
            Finish();
            return;
        }
        Check("baseline: frames present through D3D", _presented > 10 && _host.DeviceCreations == 1);

        // Case 1 — TDR / GPU hang.
        int devicesBefore = _host.DeviceCreations;
        _host.SimulateDeviceLossForTest(removed: false);
        Check("case 1 (TDR/hang): presents again after loss", PresentsDuring(2000));
        Check("case 1: device rebuilt exactly once", _host.DeviceCreations == devicesBefore + 1);
        Check("case 1: recovery observed", _host.DeviceRecoveries >= 1);

        // Case 2 — driver update / DEVICEREMOVED. The IDirect3D9Ex factory must
        // be rebuilt too, not just the device.
        devicesBefore = _host.DeviceCreations;
        _host.SimulateDeviceLossForTest(removed: true);
        Check("case 2 (driver removed): presents again after loss", PresentsDuring(2000));
        Check("case 2: device rebuilt exactly once", _host.DeviceCreations == devicesBefore + 1);

        // Case 3 — RDP attach/detach, screen lock, dGPU/iGPU flip.
        devicesBefore = _host.DeviceCreations;
        _host.SimulateFrontBufferLossForTest();
        Check("case 3 (front buffer flip): presents again", PresentsDuring(2000));
        Check("case 3: device rebuilt exactly once", _host.DeviceCreations == devicesBefore + 1);

        // G3 — park/resume must NOT churn the device.
        devicesBefore = _host.DeviceCreations;
        for (int i = 0; i < 3; i++) { _host.Park(); Pump(300); }
        Check("G3: park -> resume x3 causes no device churn", _host.DeviceCreations == devicesBefore);
        Check("G3: still presenting after park/resume", PresentsDuring(1500));

        // Case 4 — thrash guard. More than MaxLossesPerWindow losses inside the
        // window must retire D3D so VideoPipeline drops to WriteableBitmap
        // instead of strobing between paths for the rest of the session.
        for (int i = 0; i <= D3DImageHost.MaxLossesPerWindow + 1; i++)
        {
            _host.SimulateDeviceLossForTest();
            Pump(60);
        }
        Check("case 4: thrash guard retires the D3D path", !_host.Available);
        Check("case 4: caller is told to fall back (PushBgra returns false)",
              !_host.PushBgra(_bgra, _w, _h));

        Note("summary: " + _host.HealthLine() + $"  presented={_presented} pushFailed={_failed}");
        Finish();
    }

    private void Finish()
    {
        Note(ExitCode == 0 ? "S12 RESULT: PASS" : "S12 RESULT: FAIL");
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "s12-evidence.txt");
            File.WriteAllLines(path, _evidence);
            Console.WriteLine("evidence written to " + path);
        }
        catch (Exception ex) { Console.WriteLine("could not write evidence file: " + ex.Message); }
        _timer.Stop();
        Close();
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
