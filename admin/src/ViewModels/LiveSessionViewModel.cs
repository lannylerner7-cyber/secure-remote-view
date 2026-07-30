using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ConnectLive.Admin.Api;
using ConnectLive.Admin.Media;

namespace ConnectLive.Admin.ViewModels;

public partial class LiveSessionViewModel : ObservableObject
{
    public string SessionId { get; }
    public DeviceItem Device { get; }

    [ObservableProperty] private string mode = "view";
    [ObservableProperty] private bool curtainOn;
    [ObservableProperty] private string transport = "connecting";
    [ObservableProperty] private BitmapSource? currentFrame;

    // When set, the live view was superseded by another admin machine
    // taking over the same session — the window binds this to a red banner.
    [ObservableProperty] private bool takenOver;
    [ObservableProperty] private string? takenOverMessage;

    // Non-fatal background-loop errors (frame poll, signal poll, input push).
    // The window binds this to a yellow status strip so the technician sees
    // an RLS denial or 401 instead of the UI silently freezing.
    [ObservableProperty] private string? statusMessage;

    private CancellationTokenSource? _cts;
    private FrameFallbackPump? _framePump;
    private CursorPollPump? _cursorPump;
    private WebRtcClient? _rtc;

    // Latest cursor sample (normalised 0..1) bound by LiveSessionWindow.
    [ObservableProperty] private double cursorNormX;
    [ObservableProperty] private double cursorNormY;
    [ObservableProperty] private bool cursorVisible;

    public LiveSessionViewModel(string sessionId, DeviceItem device)
    {
        SessionId = sessionId;
        Device = device;
    }

    // Marshals any background-thread error onto the UI thread and auto-clears
    // the banner after 15s so a transient RLS/401 blip never leaves a stale
    // yellow strip parked above the live view.
    private int _statusEpoch;
    private void SurfaceError(string msg)
    {
        var epoch = System.Threading.Interlocked.Increment(ref _statusEpoch);
        Application.Current?.Dispatcher.InvokeAsync(() => StatusMessage = msg);
        _ = Task.Run(async () =>
        {
            try { await Task.Delay(15_000).ConfigureAwait(false); } catch { return; }
            if (System.Threading.Volatile.Read(ref _statusEpoch) != epoch) return;
            Application.Current?.Dispatcher.InvokeAsync(() =>
            {
                if (StatusMessage == msg) StatusMessage = null;
            });
        });
    }


    private void HandleTakenOver()
    {
        Application.Current?.Dispatcher.Invoke(() =>
        {
            TakenOver = true;
            TakenOverMessage = "This session was taken over by another admin console.";
            Transport = "ended";
        });
        try { _cts?.Cancel(); } catch { }
    }

    // Last time a decoded frame arrived (either transport). Drives the
    // "stalled" indicator so a frozen picture is never mistaken for a static
    // desktop.
    private DateTime _lastFrameUtc = DateTime.MinValue;

    [ObservableProperty] private string linkState = "connecting";

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _framePump = new FrameFallbackPump(SessionId,
            bmp => Application.Current?.Dispatcher.Invoke(() => CurrentFrame = bmp),
            onError: SurfaceError,
            onSuperseded: HandleTakenOver,
            onFrameStamp: utc => _lastFrameUtc = utc);
        _framePump.Start(_cts.Token);
        Transport = "http-poll";

        _cursorPump = new CursorPollPump(SessionId, sample =>
        {
            Application.Current?.Dispatcher.Invoke(() =>
            {
                if (sample == null || !sample.Visible ||
                    sample.FrameW is null or 0 || sample.FrameH is null or 0)
                {
                    CursorVisible = false;
                    return;
                }
                CursorNormX = Math.Clamp((double)sample.X / sample.FrameW.Value, 0, 1);
                CursorNormY = Math.Clamp((double)sample.Y / sample.FrameH.Value, 0, 1);
                CursorVisible = true;
            });
        }, onError: SurfaceError);
        _cursorPump.Start(_cts.Token);

        _rtc = new WebRtcClient(SessionId);
        _ = _rtc.StartAsync(_cts.Token,
            onConnected: () =>
            {
                Application.Current?.Dispatcher.Invoke(() =>
                {
                    Transport = "webrtc";
                    StatusMessage = null;
                });
            },
            onTerminated: HandleTakenOver,
            onError: SurfaceError);

        StartLinkWatchdog(_cts.Token);
    }

    // 1 Hz UI-thread tick that reports how fresh the picture actually is.
    private void StartLinkWatchdog(CancellationToken ct)
    {
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try { await Task.Delay(1000, ct).ConfigureAwait(false); } catch { return; }
                var last = _lastFrameUtc;
                string state;
                if (last == DateTime.MinValue) state = "waiting for agent…";
                else
                {
                    var age = (DateTime.UtcNow - last).TotalSeconds;
                    state = age < 2 ? "live" : age < 10 ? $"stalled {(int)age}s" : $"no frames {(int)age}s";
                }
                Application.Current?.Dispatcher.InvokeAsync(() => LinkState = state);
            }
        }, CancellationToken.None);
    }


    public void Stop()
    {
        try { _cts?.Cancel(); } catch { }
        try { _rtc?.Close(); } catch { }
        _rtc = null;
        _framePump = null;
        _cursorPump = null;
        _ = App.Api.EndSessionAsync(SessionId, CancellationToken.None);
    }

    // Queue a power command for the agent's PowerRelay
    // (kind ∈ shutdown | restart | lock | logoff | wake).
    [RelayCommand]
    private async Task PowerCommand(string kind)
    {
        if (string.IsNullOrEmpty(kind)) return;
        try
        {
            await App.Api.EnqueuePowerCommandAsync(Device.RowId, kind, null, CancellationToken.None);
            StatusMessage = $"Power command '{kind}' queued.";
        }
        catch (SupabaseCallException ex) { SurfaceError(ex.Message); }
        catch (Exception ex) { SurfaceError(ex.Message); }
    }

    [RelayCommand]
    private async Task TogglePause()
    {
        var newMode = Mode == "control" ? "view" : "control";
        try
        {
            await App.Api.SetSessionModeAsync(SessionId, newMode, CancellationToken.None);
            Mode = newMode;
            if (newMode == "view")
                await App.Api.PushInputAsync(SessionId, "release_inputs", new { }, CancellationToken.None);
            StatusMessage = null;
        }
        catch (SupabaseCallException ex) { SurfaceError(ex.Message); }
        catch (Exception ex) { SurfaceError(ex.Message); }
    }

    [RelayCommand]
    private async Task ToggleCurtain()
    {
        var next = !CurtainOn;
        try
        {
            await App.Api.PushInputAsync(SessionId, next ? "curtain_on" : "curtain_off",
                new { }, CancellationToken.None);
            CurtainOn = next;
            StatusMessage = null;
        }
        catch (SupabaseCallException ex) { SurfaceError(ex.Message); }
        catch (Exception ex) { SurfaceError(ex.Message); }
    }
}
