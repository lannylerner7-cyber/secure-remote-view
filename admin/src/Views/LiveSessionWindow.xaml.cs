using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using ConnectLive.Admin.Input;
using ConnectLive.Admin.Ui;
using ConnectLive.Admin.ViewModels;

namespace ConnectLive.Admin.Views;

public partial class LiveSessionWindow : Window
{
    private readonly LiveSessionViewModel _vm;
    private readonly MouseInjector _mouse;
    private readonly KeyboardInjector _kb;
    private readonly InputCoalescer _coalesce;

    public LiveSessionWindow(string sessionId, DeviceItem device)
    {
        InitializeComponent();
        AppIcon.Apply(this);
        _vm = new LiveSessionViewModel(sessionId, device);
        DataContext = _vm;
        DeviceLabel.Text = device.DisplayName;

        _mouse = new MouseInjector(sessionId);
        _kb = new KeyboardInjector(sessionId);
        _coalesce = new InputCoalescer(_mouse);

        Loaded += (_, _) => { _vm.Start(); _coalesce.Start(); };
        Closed += (_, _) => { _coalesce.Stop(); _vm.Stop(); };
        KeyDown += OnKeyDown;
        KeyUp += OnKeyUp;
        TextInput += OnTextInput;

        FrameImage.SizeChanged += (_, _) => UpdateCursorGhost();
        _vm.PropertyChanged += Vm_PropertyChanged;
    }

    private void Vm_PropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(LiveSessionViewModel.CursorNormX) ||
            e.PropertyName == nameof(LiveSessionViewModel.CursorNormY) ||
            e.PropertyName == nameof(LiveSessionViewModel.CursorVisible))
        {
            UpdateCursorGhost();
        }
    }

    private void UpdateCursorGhost()
    {
        if (!_vm.CursorVisible) { CursorGhost.Visibility = Visibility.Collapsed; return; }
        double w = FrameImage.ActualWidth;
        double h = FrameImage.ActualHeight;
        if (w <= 0 || h <= 0) { CursorGhost.Visibility = Visibility.Collapsed; return; }
        Canvas.SetLeft(CursorGhost, _vm.CursorNormX * w - 1);
        Canvas.SetTop(CursorGhost, _vm.CursorNormY * h - 1);
        CursorGhost.Visibility = Visibility.Visible;
    }

    private (double x, double y) ToAbs(MouseEventArgs e)
    {
        var p = e.GetPosition(FrameImage);
        var w = FrameImage.ActualWidth;
        var h = FrameImage.ActualHeight;
        if (w <= 0 || h <= 0) return (0, 0);
        return (System.Math.Clamp(p.X / w, 0, 1), System.Math.Clamp(p.Y / h, 0, 1));
    }

    private void Frame_MouseMove(object sender, MouseEventArgs e)
    {
        var (x, y) = ToAbs(e);
        _coalesce.Update(x, y);
    }

    private async void Frame_MouseDown(object sender, MouseButtonEventArgs e)
    {
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.DownAsync("left", x, y);
    }

    private async void Frame_MouseUp(object sender, MouseButtonEventArgs e)
    {
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.UpAsync("left", x, y);
    }

    private async void Frame_MouseRightDown(object sender, MouseButtonEventArgs e)
    {
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.DownAsync("right", x, y);
    }

    private async void Frame_MouseRightUp(object sender, MouseButtonEventArgs e)
    {
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.UpAsync("right", x, y);
    }

    private async void Frame_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        _coalesce.FlushNow();
        await _mouse.WheelAsync(0, e.Delta);
    }

    private async void OnKeyDown(object sender, KeyEventArgs e)
    {
        var ctrl = (Keyboard.Modifiers & ModifierKeys.Control) != 0;
        var shift = (Keyboard.Modifiers & ModifierKeys.Shift) != 0;
        var alt = (Keyboard.Modifiers & ModifierKeys.Alt) != 0;
        _coalesce.FlushNow();
        await _kb.KeyAsync(e.Key.ToString(), true, ctrl, shift, alt);
    }

    private async void OnKeyUp(object sender, KeyEventArgs e)
    {
        var ctrl = (Keyboard.Modifiers & ModifierKeys.Control) != 0;
        var shift = (Keyboard.Modifiers & ModifierKeys.Shift) != 0;
        var alt = (Keyboard.Modifiers & ModifierKeys.Alt) != 0;
        _coalesce.FlushNow();
        await _kb.KeyAsync(e.Key.ToString(), false, ctrl, shift, alt);
    }


    private async void OnTextInput(object sender, TextCompositionEventArgs e)
    {
        if (!string.IsNullOrEmpty(e.Text))
            await _kb.TextAsync(e.Text);
    }

    private void EndSession_Click(object sender, RoutedEventArgs e) => Close();
}
