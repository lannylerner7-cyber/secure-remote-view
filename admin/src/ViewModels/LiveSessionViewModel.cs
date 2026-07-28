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
    private WebRtcClient? _rtc;

    public LiveSessionViewModel(string sessionId, DeviceItem device)
    {
        SessionId = sessionId;
        Device = device;
    }

    // Marshals any background-thread error onto the UI thread.
    private void SurfaceError(string msg)
    {
        Application.Current?.Dispatcher.InvokeAsync(() => StatusMessage = msg);
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _framePump = new FrameFallbackPump(SessionId,
            bmp => Application.Current?.Dispatcher.Invoke(() => CurrentFrame = bmp),
            onError: SurfaceError);
        _framePump.Start(_cts.Token);
        Transport = "http-poll";

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
            onTerminated: () =>
            {
                Application.Current?.Dispatcher.Invoke(() =>
                {
                    TakenOver = true;
                    TakenOverMessage = "This session was taken over by another admin console.";
                    Transport = "ended";
                });
                // Stop polling and background loops; the window can stay open
                // to display the banner until the technician closes it.
                try { _cts?.Cancel(); } catch { }
            },
            onError: SurfaceError);
    }

    public void Stop()
    {
        try { _cts?.Cancel(); } catch { }
        try { _rtc?.Close(); } catch { }
        _rtc = null;
        _framePump = null;
        _ = App.Api.EndSessionAsync(SessionId, CancellationToken.None);
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
