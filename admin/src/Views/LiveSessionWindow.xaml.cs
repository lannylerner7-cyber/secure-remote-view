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
        // Tunnelled key events so the live surface wins over WPF focus
        // navigation (Tab, arrows, Alt menus) before it can swallow them.
        PreviewKeyDown += OnKeyDown;
        PreviewKeyUp += OnKeyUp;
        TextInput += OnTextInput;

        // Recompute the content rect on element resize AND whenever the source
        // changes size mid-session (Phase 4 resolution change).
        FrameImage.SizeChanged += (_, _) => UpdateCursorGhost();
        _vm.PropertyChanged += Vm_PropertyChanged;
    }

    private void Vm_PropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(LiveSessionViewModel.CursorNormX) ||
            e.PropertyName == nameof(LiveSessionViewModel.CursorNormY) ||
            e.PropertyName == nameof(LiveSessionViewModel.CursorVisible) ||
            e.PropertyName == nameof(LiveSessionViewModel.CurrentFrame))
        {
            UpdateCursorGhost();
        }
    }

    /// <summary>
    /// Phase 5 — the ONE place element-space and source-space meet.
    /// Stretch="Uniform" letterboxes the picture; every conversion must go
    /// through <see cref="ContentRect"/> or clicks land off-target and the
    /// ghost cursor drifts toward the edges.
    /// </summary>
    private ContentRect Rect()
    {
        var src = FrameImage.Source;
        if (src == null) return ContentRect.Empty;
        double srcW = src.Width, srcH = src.Height;
        if (src is System.Windows.Media.Imaging.BitmapSource bs) { srcW = bs.PixelWidth; srcH = bs.PixelHeight; }
        else if (src is System.Windows.Interop.D3DImage d3d) { srcW = d3d.PixelWidth; srcH = d3d.PixelHeight; }
        return ContentRect.Compute(FrameImage.ActualWidth, FrameImage.ActualHeight, srcW, srcH);
    }

    private void UpdateCursorGhost()
    {
        if (!_vm.CursorVisible) { CursorGhost.Visibility = Visibility.Collapsed; return; }
        var r = Rect();
        if (!r.IsValid) { CursorGhost.Visibility = Visibility.Collapsed; return; }
        // Offset by the letterbox bars, not by the raw element size.
        var (x, y) = r.ToElement(_vm.CursorNormX, _vm.CursorNormY);
        Canvas.SetLeft(CursorGhost, x - 1);
        Canvas.SetTop(CursorGhost, y - 1);
        CursorGhost.Visibility = Visibility.Visible;
    }

    private (double x, double y) ToAbs(MouseEventArgs e)
    {
        var r = Rect();
        if (!r.IsValid) return (0, 0);
        var p = e.GetPosition(FrameImage);
        return r.Normalize(p.X, p.Y);
    }

    /// <summary>True when the pointer is on the picture, not the black bar.</summary>
    private bool OnPicture(MouseEventArgs e)
    {
        var r = Rect();
        if (!r.IsValid) return false;
        var p = e.GetPosition(FrameImage);
        return r.Contains(p.X, p.Y);
    }


    private void Frame_MouseMove(object sender, MouseEventArgs e)
    {
        if (!OnPicture(e)) return;      // letterbox bar: not part of the desktop
        var (x, y) = ToAbs(e);
        _coalesce.Update(x, y);
    }

    private async void Frame_MouseDown(object sender, MouseButtonEventArgs e)
    {
        Keyboard.Focus(this);
        if (!OnPicture(e)) return;
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.DownAsync(MouseInjector.Left, x, y);
    }

    private async void Frame_MouseUp(object sender, MouseButtonEventArgs e)
    {
        if (!OnPicture(e)) return;
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.UpAsync(MouseInjector.Left, x, y);
    }

    private async void Frame_MouseRightDown(object sender, MouseButtonEventArgs e)
    {
        if (!OnPicture(e)) return;
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.DownAsync(MouseInjector.Right, x, y);
    }

    private async void Frame_MouseRightUp(object sender, MouseButtonEventArgs e)
    {
        if (!OnPicture(e)) return;
        var (x, y) = ToAbs(e);
        _coalesce.FlushNow();
        await _mouse.UpAsync(MouseInjector.Right, x, y);
    }

    private async void Frame_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (!OnPicture(e)) return;
        // Park the pointer at the wheel position first so the remote machine
        // scrolls the control under the cursor, not whatever had focus.
        var (x, y) = ToAbs(e);
        _coalesce.Update(x, y);
        _coalesce.FlushNow();
        await _mouse.WheelAsync(e.Delta);
    }


    // Alt-combos arrive as Key.System with the real key in SystemKey.
    private static Key Effective(KeyEventArgs e) => e.Key == Key.System ? e.SystemKey : e.Key;

    private static bool IsPrintable(Key key)
    {
        var mods = Keyboard.Modifiers;
        if ((mods & (ModifierKeys.Control | ModifierKeys.Alt | ModifierKeys.Windows)) != 0) return false;
        return (key >= Key.A && key <= Key.Z)
            || (key >= Key.D0 && key <= Key.D9)
            || (key >= Key.NumPad0 && key <= Key.NumPad9)
            || (key >= Key.Oem1 && key <= Key.OemBackslash)
            || key == Key.Space;
    }

    private async void OnKeyDown(object sender, KeyEventArgs e)
    {
        var key = Effective(e);
        e.Handled = true;
        // Unmodified printable keys are delivered by TextInput as Unicode so
        // the remote layout, dead keys and IME composition all behave.
        if (IsPrintable(key)) return;
        _coalesce.FlushNow();
        await _kb.KeyAsync(key, true);
    }

    private async void OnKeyUp(object sender, KeyEventArgs e)
    {
        var key = Effective(e);
        e.Handled = true;
        if (IsPrintable(key)) return;
        _coalesce.FlushNow();
        await _kb.KeyAsync(key, false);
    }


    private async void OnTextInput(object sender, TextCompositionEventArgs e)
    {
        if (!string.IsNullOrEmpty(e.Text))
            await _kb.TextAsync(e.Text);
    }

    private void EndSession_Click(object sender, RoutedEventArgs e) => Close();
}
