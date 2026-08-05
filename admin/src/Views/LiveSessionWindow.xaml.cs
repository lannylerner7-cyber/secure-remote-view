using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

using ConnectLive.Admin.Input;
using ConnectLive.Admin.Media;

using ConnectLive.Admin.Ui;
using ConnectLive.Admin.ViewModels;

namespace ConnectLive.Admin.Views;

public partial class LiveSessionWindow : Window
{
    private readonly LiveSessionViewModel _vm;
    private readonly MouseInjector _mouse;
    private readonly KeyboardInjector _kb;
    private readonly InputCoalescer _coalesce;

    // SCOPE:RENDER — client-side prediction for the ghost pointer. See
    // PredictiveCursor for the reconciliation contract.
    private readonly PredictiveCursor _predict = new();
    private EventHandler? _renderTick;

    // S19(b) — pointer capture (relative motion). Created after
    // InitializeComponent so the surface element exists.
    private readonly PointerCapture _capture;


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
        _capture = new PointerCapture(Stage);


        // Authoritative telemetry arrives here exactly once per sample.
        _vm.CursorSample += OnCursorSample;

        // Focus the window on load, not only on the first click: a session you
        // never clicked into would otherwise receive no keyboard input at all.
        Loaded += (_, _) =>
        {
            // S16 — the D3D device must be associated with THIS window. The
            // host previously fell back to Application.Current.MainWindow,
            // which in this app is the device list and never presents video;
            // several drivers answer that with a black or frozen surface while
            // every upload still reports success.
            _vm.PresentationWindow = new System.Windows.Interop.WindowInteropHelper(this).EnsureHandle();
            _vm.Start();
            _coalesce.Start();
            StartRenderTick();
            Activate();
            // Focus the live surface, not the window: key interception below is
            // scoped to Stage so the toolbar keeps normal Tab/Enter/Space.
            Keyboard.Focus(Stage);

        };

        Closed += (_, _) =>
        {
            StopRenderTick();
            _vm.CursorSample -= OnCursorSample;
            _predict.Reset();
            EndCapture();
            _coalesce.Stop();
            _vm.Stop();
        };
        // Losing focus mid-keystroke means the matching key-up never reaches
        // us; drop the pending stamps so a later press of the same key cannot
        // fire a spurious raw-key fallback.
        // Losing activation while captured must also free the physical cursor,
        // otherwise the technician cannot reach any other window.
        Deactivated += (_, _) => { _awaitingText.Clear(); EndCapture(); };
        // Tunnelled key events so the live surface wins over WPF focus
        // navigation (Tab, arrows, Alt menus) before it can swallow them.
        PreviewKeyDown += OnKeyDown;
        PreviewKeyUp += OnKeyUp;
        TextInput += OnTextInput;

        // Recompute the content rect on element resize AND whenever the source
        // changes size mid-session (Phase 4 resolution change).
        FrameImage.SizeChanged += (_, _) => UpdateCursorGhost();
        // The capture anchor is the centre of the live surface, so it moves
        // whenever the surface does.
        Stage.SizeChanged += (_, _) => _capture.Recenter();
        LocationChanged += (_, _) => _capture.Recenter();
        _vm.PropertyChanged += Vm_PropertyChanged;
        SyncPredictionGate();
        SyncLocalCursor();
    }

    // ---------------------------------------------------------------------
    // S19 — local cursor draw + pointer capture
    //
    // (a) While this console is authoritative the OS cursor is hidden over the
    //     stage and the orange ghost — drawn from LOCAL input by
    //     PredictiveCursor — is the only pointer on screen. That is what makes
    //     the pointer track the hand instead of the decoded video.
    // (b) Capture mode parks the physical cursor on the surface centre and
    //     streams relative motion, so the remote pointer is unbounded.
    // ---------------------------------------------------------------------

    private void SyncLocalCursor()
    {
        var hide = _capture.Engaged || _vm.InputAuthoritative;
        var c = hide ? Cursors.None : Cursors.Arrow;
        Stage.Cursor = c;
        FrameImage.Cursor = c;
    }

    private void Capture_Changed(object sender, RoutedEventArgs e)
    {
        if (CaptureToggle.IsChecked == true)
        {
            Keyboard.Focus(Stage);
            if (!_capture.Engage())
            {
                // Surface not realised yet (or no presentation source): fail
                // visibly rather than leaving a toggle that lies.
                CaptureToggle.IsChecked = false;
                return;
            }
        }
        else
        {
            _capture.Release();
        }
        SyncLocalCursor();
    }

    /// <summary>Release capture from anywhere (Esc/F8, deactivate, close).</summary>
    private void EndCapture()
    {
        if (!_capture.Engaged) return;
        _capture.Release();
        CaptureToggle.IsChecked = false;
        SyncLocalCursor();
    }


    private void OnCursorSample(double nx, double ny, bool visible)
        => _predict.Observe(nx, ny, visible);

    /// <summary>
    /// Prediction is only allowed while this console is actually driving the
    /// remote pointer. In view mode, while paused, or after a take-over the
    /// overlay reverts to pure telemetry so it can't lie about a session that
    /// isn't accepting our input.
    /// </summary>
    private void SyncPredictionGate()
    {
        var allowed = _vm.InputAuthoritative;
        if (_predict.Enabled == allowed) return;
        _predict.Enabled = allowed;
        if (!allowed) _predict.Surrender();
    }

    // Draw at display refresh rather than on telemetry arrival: prediction and
    // the ease-toward-truth both need a steady tick, and CompositionTarget
    // gives us one that is already synchronised with WPF's render pass.
    private void StartRenderTick()
    {
        if (_renderTick != null) return;
        _renderTick = (_, _) => UpdateCursorGhost();
        CompositionTarget.Rendering += _renderTick;
    }

    private void StopRenderTick()
    {
        if (_renderTick == null) return;
        CompositionTarget.Rendering -= _renderTick;
        _renderTick = null;
    }

    private void Vm_PropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(LiveSessionViewModel.InputAuthoritative))
        {
            SyncPredictionGate();
            // S19(a) — the OS cursor only hides while we own the remote
            // pointer; a view-only session keeps its normal arrow.
            SyncLocalCursor();
            if (!_vm.InputAuthoritative) EndCapture();
        }
        else if (e.PropertyName == nameof(LiveSessionViewModel.CurrentFrame))
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
        // allowUpscale MUST equal (FrameImage.StretchDirection != DownOnly).
        // Read it off the element itself so XAML stays the single declaration.
        return ContentRect.Compute(FrameImage.ActualWidth, FrameImage.ActualHeight, srcW, srcH,
            allowUpscale: FrameImage.StretchDirection != StretchDirection.DownOnly);
    }

    /// <summary>
    /// Fit ⇄ 1:1. Fit scales the desktop to the window (upscale allowed);
    /// 1:1 presents native pixels inside a scroll viewer. ContentRect derives
    /// allowUpscale from the Image's live StretchDirection, so the input and
    /// ghost-cursor geometry follow this switch with no extra state.
    /// </summary>
    private void ViewMode_Changed(object sender, RoutedEventArgs e)
    {
        var oneToOne = OneToOneToggle.IsChecked == true;
        if (oneToOne)
        {
            FrameImage.Stretch = Stretch.None;
            FrameImage.StretchDirection = StretchDirection.DownOnly;
            FrameScroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
            FrameScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        }
        else
        {
            FrameImage.Stretch = Stretch.Uniform;
            FrameImage.StretchDirection = StretchDirection.Both;
            FrameScroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
            FrameScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Disabled;
        }
        UpdateCursorGhost();
        Keyboard.Focus(Stage);
    }

    private void UpdateCursorGhost()
    {
        // Sample() advances prediction expiry and the fade, so it must be
        // called every tick — even when we end up hiding the ghost.
        var (nx, ny, visible) = _predict.Sample();
        // Sample() already folds in telemetry visibility: it returns false when
        // the agent reports no cursor and we are not predicting, so gating on
        // the VM flag as well would suppress the ghost during the window
        // before the first telemetry row arrives.
        if (!visible) { CursorGhost.Visibility = Visibility.Collapsed; return; }

        var r = Rect();
        if (!r.IsValid) { CursorGhost.Visibility = Visibility.Collapsed; return; }
        // Offset by the letterbox bars, not by the raw element size.
        var (x, y) = r.ToElement(nx, ny);
        // The overlay canvas is a sibling of the ScrollViewer, so image-space
        // has to be mapped into canvas-space or the ghost ignores the scroll
        // offset in 1:1 mode.
        Point onCanvas;
        try { onCanvas = FrameImage.TransformToVisual(CursorLayer).Transform(new Point(x, y)); }
        catch { CursorGhost.Visibility = Visibility.Collapsed; return; }
        Canvas.SetLeft(CursorGhost, onCanvas.X - 1);
        Canvas.SetTop(CursorGhost, onCanvas.Y - 1);
        // Predicted = the technician's own hand (solid); telemetry = the remote
        // machine's pointer (dimmed), so the two are never confused on screen.
        CursorGhost.Opacity = _predict.IsPredicting ? 1.0 : 0.75;
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
        if (_capture.Engaged) { HandleCapturedMove(e); return; }
        if (!OnPicture(e)) return;      // letterbox bar: not part of the desktop
        var (x, y) = ToAbs(e);
        // Prediction FIRST — the ghost must move on this frame, not on the
        // frame after the agent's telemetry round trip completes.
        _predict.Predict(x, y);
        _coalesce.Update(x, y);
        _lastNormX = x; _lastNormY = y;
    }

    // In capture mode the mouse is captured by Stage, so moves arrive here
    // (the picture may not be under the physical pointer at all).
    private void Stage_MouseMove(object sender, MouseEventArgs e)
    {
        if (_capture.Engaged) HandleCapturedMove(e);
    }

    // Delegates: only live while captured (see the XAML comment on Stage).
    private void Stage_MouseDown(object sender, MouseButtonEventArgs e) { if (_capture.Engaged) Frame_MouseDown(sender, e); }
    private void Stage_MouseUp(object sender, MouseButtonEventArgs e) { if (_capture.Engaged) Frame_MouseUp(sender, e); }
    private void Stage_MouseRightDown(object sender, MouseButtonEventArgs e) { if (_capture.Engaged) Frame_MouseRightDown(sender, e); }
    private void Stage_MouseRightUp(object sender, MouseButtonEventArgs e) { if (_capture.Engaged) Frame_MouseRightUp(sender, e); }
    private void Stage_MouseWheel(object sender, MouseWheelEventArgs e) { if (_capture.Engaged) Frame_MouseWheel(sender, e); }



    private double _lastNormX = 0.5, _lastNormY = 0.5;

    /// <summary>
    /// S19(b) — one physical move becomes: a relative delta on the wire, and a
    /// locally integrated normalised position so the ghost cursor and any
    /// following click still have coordinates to work with.
    /// </summary>
    private void HandleCapturedMove(MouseEventArgs e)
    {
        Point screen;
        try { screen = Stage.PointToScreen(e.GetPosition(Stage)); }
        catch { return; }
        if (!_capture.Consume(screen, out var dx, out var dy)) return;

        _coalesce.UpdateRel(dx, dy);

        // Integrate locally for the ghost. Source pixels, not element pixels:
        // one physical pixel of hand movement is one remote pixel.
        var (sw, sh) = SourceSize();
        if (sw > 0 && sh > 0)
        {
            _lastNormX = Math.Clamp(_lastNormX + dx / sw, 0, 1);
            _lastNormY = Math.Clamp(_lastNormY + dy / sh, 0, 1);
            _predict.Predict(_lastNormX, _lastNormY);
        }
    }

    private (double w, double h) SourceSize()
    {
        var src = FrameImage.Source;
        if (src == null) return (0, 0);
        if (src is System.Windows.Media.Imaging.BitmapSource bs) return (bs.PixelWidth, bs.PixelHeight);
        if (src is System.Windows.Interop.D3DImage d3d) return (d3d.PixelWidth, d3d.PixelHeight);
        return (src.Width, src.Height);
    }

    /// <summary>
    /// Coordinates for a button/wheel event. Captured sessions have no
    /// meaningful element position, so the locally integrated point is used
    /// and the on-picture gate is skipped.
    /// </summary>
    private bool TryPointFor(MouseEventArgs e, out double x, out double y)
    {
        if (_capture.Engaged) { x = _lastNormX; y = _lastNormY; return true; }
        if (!OnPicture(e)) { x = y = 0; return false; }
        (x, y) = ToAbs(e);
        return true;
    }

    private async void Frame_MouseDown(object sender, MouseButtonEventArgs e)
    {
        Keyboard.Focus(Stage);
        if (!TryPointFor(e, out var x, out var y)) return;
        _predict.Predict(x, y);
        _coalesce.FlushNow();
        await _mouse.DownAsync(MouseInjector.Left, x, y);
    }

    private async void Frame_MouseUp(object sender, MouseButtonEventArgs e)
    {
        if (!TryPointFor(e, out var x, out var y)) return;
        _predict.Predict(x, y);
        _coalesce.FlushNow();
        await _mouse.UpAsync(MouseInjector.Left, x, y);
    }

    private async void Frame_MouseRightDown(object sender, MouseButtonEventArgs e)
    {
        if (!TryPointFor(e, out var x, out var y)) return;
        _predict.Predict(x, y);
        _coalesce.FlushNow();
        await _mouse.DownAsync(MouseInjector.Right, x, y);
    }

    private async void Frame_MouseRightUp(object sender, MouseButtonEventArgs e)
    {
        if (!TryPointFor(e, out var x, out var y)) return;
        _predict.Predict(x, y);
        _coalesce.FlushNow();
        await _mouse.UpAsync(MouseInjector.Right, x, y);
    }

    private async void Frame_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (!TryPointFor(e, out var x, out var y)) return;
        // Park the pointer at the wheel position first so the remote machine
        // scrolls the control under the cursor, not whatever had focus.
        _predict.Predict(x, y);
        if (!_capture.Engaged) _coalesce.Update(x, y);
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

    // Printable keys whose TextInput character has not arrived yet, in press
    // order. A single field was not enough: with fast overlapping typing (B
    // pressed before A is released) one slot loses track of which key is still
    // unaccounted for, and the fallback silently stops firing. WPF delivers
    // TextInput immediately after the KeyDown that produced it, so the newest
    // entry is always the one a character belongs to.
    private readonly List<Key> _awaitingText = new();
    private const int AwaitingTextCap = 16;

    /// <summary>
    /// Keys are only forwarded to the remote machine while the live surface
    /// owns focus. Without this gate the window-level tunnelled handlers
    /// marked Enter/Space/Tab/arrows handled everywhere, which killed keyboard
    /// operation of the toolbar (and of the Power menu) entirely.
    /// </summary>
    private bool StageHasFocus => Stage.IsKeyboardFocusWithin;

    private async void OnKeyDown(object sender, KeyEventArgs e)
    {
        if (!StageHasFocus) return;
        var key = Effective(e);
        // Unmodified printable keys are delivered by TextInput as Unicode so
        // the remote layout, dead keys and IME composition all behave. WPF only
        // raises TextInput for key events it has NOT seen marked handled, so
        // these must be left unhandled here.
        if (IsPrintable(key))
        {
            _awaitingText.Add(key);
            // Never let a pathological layout that emits no TextInput at all
            // grow this without bound; the oldest entry is the least useful.
            if (_awaitingText.Count > AwaitingTextCap) _awaitingText.RemoveAt(0);
            return;
        }
        e.Handled = true;
        _coalesce.FlushNow();
        await _kb.KeyAsync(key, true);
    }

    private async void OnKeyUp(object sender, KeyEventArgs e)
    {
        if (!StageHasFocus) return;
        var key = Effective(e);
        if (IsPrintable(key))
        {
            // Anything still pending for this key means no character was ever
            // composed for it (dead keys, exotic layouts). Drop every stale
            // entry for the key and send it raw exactly once.
            var missed = false;
            for (var i = _awaitingText.Count - 1; i >= 0; i--)
            {
                if (_awaitingText[i] != key) continue;
                _awaitingText.RemoveAt(i);
                missed = true;
            }
            if (missed)
            {
                // Safety net: no character was composed for this key.
                _coalesce.FlushNow();
                await _kb.KeyAsync(key, true);
                await _kb.KeyAsync(key, false);
            }
            return;
        }
        e.Handled = true;
        _coalesce.FlushNow();
        await _kb.KeyAsync(key, false);
    }


    private async void OnTextInput(object sender, TextCompositionEventArgs e)
    {
        if (!StageHasFocus) return;
        e.Handled = true;
        if (string.IsNullOrEmpty(e.Text)) return;
        // This character settles the most recent pending key, so its fallback
        // must not fire on key-up.
        if (_awaitingText.Count > 0) _awaitingText.RemoveAt(_awaitingText.Count - 1);
        await _kb.TextAsync(e.Text);
    }



    private void EndSession_Click(object sender, RoutedEventArgs e) => Close();
}
