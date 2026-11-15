using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace ConnectLive.Agent;

/// <summary>The explicit active-audio exception to the pairing-only Agent UI.</summary>
internal sealed class MicrophoneIndicator : IDisposable
{
    [DllImport("user32.dll")] private static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
    private Window? _window;
    private DispatcherTimer? _timer;
    private IntPtr _handle;
    private readonly Action _stop;
    private bool _disposing;
    internal MicrophoneIndicator(Action stop)
    {
        _stop = stop;
        Application.Current.Dispatcher.Invoke(() => {
            var stopButton = new Button { Content = "Stop microphone", Margin = new Thickness(8), Padding = new Thickness(12,5,12,5) };
            stopButton.Click += (_, _) => _stop();
            var panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = "Microphone sharing is ON", Foreground = Brushes.White,
                FontWeight = FontWeights.Bold, Margin = new Thickness(12,10,12,2) });
            panel.Children.Add(new TextBlock { Text = "Ctrl+Alt+Shift+M stops audio, even with curtain", Foreground = Brushes.White,
                Margin = new Thickness(12,2,12,4), TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(stopButton);
            _window = new Window { Title = "ConnectLive microphone sharing", Content = panel, Width = 390,
                SizeToContent = SizeToContent.Height, ResizeMode = ResizeMode.NoResize, Topmost = true,
                ShowInTaskbar = true, Background = new SolidColorBrush(Color.FromRgb(145, 32, 48)),
                WindowStartupLocation = WindowStartupLocation.CenterScreen };
            _window.Closing += (_, _) => { if (!_disposing) _stop(); };
            _window.Show();
            _handle = new WindowInteropHelper(_window).Handle;
            if (!SetWindowDisplayAffinity(_handle, 0x11)) { _disposing = true; _window.Close(); throw new InvalidOperationException("indicator_unavailable"); }
            HwndSource.FromHwnd(_handle)?.AddHook((IntPtr h, int message, IntPtr w, IntPtr l, ref bool handled) => {
                if (message == 0x0312 && w.ToInt32() == 4101) { handled = true; _stop(); }
                return IntPtr.Zero;
            });
            if (!RegisterHotKey(_handle, 4101, 0x4000 | 1 | 2 | 4, 0x4D))
            { _disposing = true; _window.Close(); throw new InvalidOperationException("local_stop_unavailable"); }
            // Curtain windows are also topmost. Keep the audio notice above
            // them without changing the curtain or re-enabling normal input.
            _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            _timer.Tick += (_, _) => SetWindowPos(_handle, new IntPtr(-1), 0,0,0,0, 0x13);
            _timer.Start();
        });
        InputBlocker.LocalMicrophoneStopRequested += _stop;
    }
    public void Dispose()
    {
        InputBlocker.LocalMicrophoneStopRequested -= _stop;
        Application.Current.Dispatcher.BeginInvoke(new Action(() => {
            _disposing = true; _timer?.Stop(); UnregisterHotKey(_handle, 4101); _window?.Close(); _window = null;
        }));
    }
}
