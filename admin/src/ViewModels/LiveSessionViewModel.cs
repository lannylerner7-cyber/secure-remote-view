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
    // Shared transport taxonomy with the web console:
    // "Native video" | "Realtime frames" | "Frame fallback" | "Reconnecting" | "Ended".
    // Phase 6 pill honesty: "Native video" appears ONLY while decoded frames
    // are actually being presented. Everything else is labelled as the
    // fallback it is.
    [ObservableProperty] private string transport = "Reconnecting";

    // The one thing the live surface renders. Holds the decoded D3DImage /
    // WriteableBitmap while the native path is presenting, and the JPEG still
    // otherwise. Typed as ImageSource because D3DImage is not a BitmapSource.
    [ObservableProperty] private System.Windows.Media.ImageSource? currentFrame;

    // True while decoded VP8 frames are reaching the screen. JPEG stills are
    // ignored while this is set so the two paths never fight over the surface.
    [ObservableProperty] private bool nativeVideo;
    [ObservableProperty] private string? videoStats;

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
    private RealtimeChannel? _realtime;
    // True while the raw Supabase Realtime socket is delivering frames — the
    // HTTP fallback pumps still run but the Realtime pipe is our fast path.
    private volatile bool _realtimeHealthy;


    // Latest cursor sample (normalised 0..1) bound by LiveSessionWindow.
    [ObservableProperty] private double cursorNormX;
    [ObservableProperty] private double cursorNormY;
    [ObservableProperty] private bool cursorVisible;

    /// <summary>
    /// SCOPE:RENDER — raised on the UI thread exactly once per authoritative
    /// cursor sample (poll pump OR realtime), carrying (normX, normY, visible).
    /// The three CursorNorm* properties can't serve this purpose: ObservableObject
    /// suppresses PropertyChanged when a value is unchanged, so a listener
    /// watching them would miss samples and mis-reconcile the prediction.
    /// </summary>
    public event Action<double, double, bool>? CursorSample;

    private void PublishCursor(double nx, double ny, bool visible)
    {
        CursorNormX = nx;
        CursorNormY = ny;
        CursorVisible = visible;
        try { CursorSample?.Invoke(nx, ny, visible); } catch { }
    }

    /// <summary>
    /// True only while this console is genuinely driving the remote pointer —
    /// control mode, curtain engaged, not superseded. The predictive cursor is
    /// gated on this so a view-only or taken-over session can never draw a
    /// pointer the agent isn't going to honour.
    /// </summary>
    public bool InputAuthoritative => Mode == "control" && CurtainOn && !TakenOver;

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
            Transport = "Ended";
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
            bmp => Application.Current?.Dispatcher.Invoke(() => { if (!NativeVideo) CurrentFrame = bmp; }),
            onError: SurfaceError,
            onSuperseded: HandleTakenOver,
            onFrameStamp: utc => _lastFrameUtc = utc);
        _framePump.Start(_cts.Token);
        Transport = "Frame fallback";


        _cursorPump = new CursorPollPump(SessionId, sample =>
        {
            Application.Current?.Dispatcher.Invoke(() =>
            {
                if (sample == null || !sample.Visible ||
                    sample.FrameW is null or 0 || sample.FrameH is null or 0)
                {
                    PublishCursor(CursorNormX, CursorNormY, false);
                    return;
                }
                PublishCursor(
                    Math.Clamp((double)sample.X / sample.FrameW.Value, 0, 1),
                    Math.Clamp((double)sample.Y / sample.FrameH.Value, 0, 1),
                    true);
            });
        }, onError: SurfaceError);

        _cursorPump.Start(_cts.Token);

        // Raw Supabase Realtime is the fast path: session_frames /
        // session_cursors rows are pushed the instant the agent writes them,
        // so the picture no longer waits on the next 200 ms poll tick. The
        // HTTP pumps above stay running as an always-on fallback if the
        // socket disconnects or the project's Realtime quota is exhausted.
        _realtime = new RealtimeChannel(
            App.Config.SupabaseUrl,
            App.Config.SupabaseAnonKey,
            App.Auth.Current?.AccessToken,
            SessionId,
            onFrameBytes: (bytes, utc) =>
            {
                if (NativeVideo) return;              // native path owns the surface
                var bmp = DecodeJpeg(bytes);
                if (bmp == null) return;
                _lastFrameUtc = utc;
                Application.Current?.Dispatcher.Invoke(() =>
                {
                    if (NativeVideo) return;
                    CurrentFrame = bmp;
                    Transport = "Realtime frames";
                });
            },
            onCursor: e =>
            {
                Application.Current?.Dispatcher.Invoke(() =>
                {
                    if (!e.Visible || e.FrameW is null or 0 || e.FrameH is null or 0)
                    {
                        CursorVisible = false;
                        return;
                    }
                    CursorNormX = Math.Clamp((double)e.X / e.FrameW.Value, 0, 1);
                    CursorNormY = Math.Clamp((double)e.Y / e.FrameH.Value, 0, 1);
                    CursorVisible = true;
                });
            },
            onError: SurfaceError,
            onHealth: healthy => _realtimeHealthy = healthy);
        _realtime.Start();

        _rtc = new WebRtcClient(SessionId);

        // The decoded surface (D3DImage, or WriteableBitmap when the D3D path
        // is unavailable) replaces the JPEG still the moment it exists.
        _rtc.Pipeline.SurfaceReady += src =>
        {
            Application.Current?.Dispatcher.Invoke(() => CurrentFrame = src);
        };

        _ = _rtc.StartAsync(_cts.Token,
            onVideoLive: () =>
            {
                Application.Current?.Dispatcher.Invoke(() =>
                {
                    NativeVideo = true;
                    Transport = "Native video";
                    StatusMessage = null;
                });
            },
            onVideoStalled: () =>
            {
                Application.Current?.Dispatcher.Invoke(() =>
                {
                    NativeVideo = false;
                    Transport = _realtimeHealthy ? "Realtime frames" : "Frame fallback";
                    LinkState = "native video stalled — fallback active";
                });
            },
            onTerminated: HandleTakenOver,
            onError: SurfaceError);

        StartLinkWatchdog(_cts.Token);
        StartVideoStats(_cts.Token);
        StartNetworkWatch();
    }

    // ---- G2 on-screen measurement ----------------------------------------
    // fps + queue depth + decode-to-present latency, refreshed once a second,
    // so "is it actually smooth" is a reading, not an opinion.
    private void StartVideoStats(CancellationToken ct)
    {
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try { await Task.Delay(1000, ct).ConfigureAwait(false); } catch { return; }
                var p = _rtc?.Pipeline;
                if (p == null) continue;
                var presenting = p.IsPresenting;
                var text = presenting
                    ? $"{p.Fps:F0} fps · {p.LastLatencyMs:F0} ms · q{p.QueueDepth} · {p.SourceWidth}x{p.SourceHeight} · {(p.UsingD3D ? "D3D" : "bitmap")}"
                    : null;
                Application.Current?.Dispatcher.InvokeAsync(() =>
                {
                    VideoStats = text;
                    if (!presenting && NativeVideo)
                    {
                        NativeVideo = false;
                        Transport = _realtimeHealthy ? "Realtime frames" : "Frame fallback";
                    }
                });
            }
        }, CancellationToken.None);
    }

    // ---- G5-F1: snap back the instant connectivity returns ----------------
    private System.Net.NetworkInformation.NetworkAddressChangedEventHandler? _netHandler;

    private void StartNetworkWatch()
    {
        _netHandler = (_, __) =>
        {
            if (_cts == null || _cts.IsCancellationRequested) return;
            SurfaceError("Network change detected — re-establishing the live link…");
            _ = ReconnectAgent();
        };
        try { System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged += _netHandler; }
        catch { _netHandler = null; }
    }

    private void StopNetworkWatch()
    {
        if (_netHandler == null) return;
        try { System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged -= _netHandler; } catch { }
        _netHandler = null;
    }


    private static BitmapSource? DecodeJpeg(byte[] bytes)
    {
        try
        {
            using var ms = new System.IO.MemoryStream(bytes);
            var decoder = BitmapDecoder.Create(ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
            if (decoder.Frames.Count == 0) return null;
            var f = decoder.Frames[0];
            f.Freeze();
            return f;
        }
        catch { return null; }
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
                if (NativeVideo) state = "live";
                else if (last == DateTime.MinValue) state = "waiting for agent…";
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
        StopCurtainHeartbeat();
        StopNetworkWatch();

        // Release the remote keyboard/mouse and drop the curtain BEFORE the
        // session row is ended — otherwise the agent keeps BlockInput engaged
        // until its 5s watchdog notices the pings stopped.
        try
        {
            _ = App.Api.PushInputAsync(SessionId, "release_inputs", new { }, CancellationToken.None);
            _ = App.Api.PushInputAsync(SessionId, "curtain_off", new { }, CancellationToken.None);
        }
        catch { }
        CurtainOn = false;

        try { _cts?.Cancel(); } catch { }
        try { _rtc?.Close(); } catch { }
        if (_realtime != null)
        {
            var rt = _realtime;
            _realtime = null;
            _ = Task.Run(async () => { try { await rt.DisposeAsync(); } catch { } });
        }
        _realtimeHealthy = false;
        _rtc = null;
        _framePump = null;
        _cursorPump = null;
        // G3: drop the decoded surface reference so nothing keeps a dead
        // D3D back-buffer alive between sessions.
        NativeVideo = false;
        VideoStats = null;
        CurrentFrame = null;
        Transport = "Ended";
        _ = App.Api.EndSessionAsync(SessionId, CancellationToken.None);
    }


    // ---- Curtain dead-man heartbeat --------------------------------------
    // The agent's InputBlocker releases the curtain after 5s without a
    // curtain_on ping (so a crashed console never leaves a user locked out).
    // The web console pings at 1s; the native console must do the same or the
    // curtain silently drops five seconds after it is engaged.
    private CancellationTokenSource? _curtainCts;

    private void StartCurtainHeartbeat()
    {
        StopCurtainHeartbeat();
        var cts = new CancellationTokenSource();
        _curtainCts = cts;
        var ct = cts.Token;
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try { await Task.Delay(1000, ct).ConfigureAwait(false); } catch { return; }
                if (ct.IsCancellationRequested) return;
                try { await App.Api.PushInputAsync(SessionId, "curtain_on", new { }, ct).ConfigureAwait(false); }
                catch { /* transient — the next tick retries */ }
            }
        }, CancellationToken.None);
    }

    private void StopCurtainHeartbeat()
    {
        try { _curtainCts?.Cancel(); } catch { }
        _curtainCts = null;
    }

    // Queue a power command for the agent's PowerRelay
    // (kind ∈ shutdown | reboot | lock | logoff | wake | wake_agent | restart_stream | restart_agent).
    [RelayCommand]
    private async Task PowerCommand(string kind)
    {
        if (string.IsNullOrEmpty(kind)) return;
        // Destructive actions get the same confirmation the web console shows.
        if (kind is "reboot" or "shutdown")
        {
            var verb = kind == "reboot" ? "Reboot" : "Shut down";
            var answer = MessageBox.Show(
                $"{verb} {Device.DisplayName} in 5 seconds?",
                "ConnectLive Admin", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
            if (answer != MessageBoxResult.OK) return;
        }
        try
        {
            await App.Api.EnqueuePowerCommandAsync(Device.RowId, kind, null, CancellationToken.None);
            StatusMessage = $"Power command '{kind}' queued.";
        }
        catch (SupabaseCallException ex) { SurfaceError(ex.Message); }
        catch (Exception ex) { SurfaceError(ex.Message); }
    }

    // Ask the agent to tear down + re-establish its WebRTC peer + capture
    // pipeline for this session without restarting the process. The Agent's
    // PowerRelay.OnRestartStream hook handles this in place.
    [RelayCommand]
    private Task RestartStream() => PowerCommand("restart_stream");

    // Ask the agent to soft-restart in-process. If the in-process reset
    // throws, PowerRelay falls back to Process.Start + Shutdown, so the
    // machine is never left offline permanently.
    [RelayCommand]
    private Task RestartAgent() => PowerCommand("restart_agent");

    // Re-arm THIS session and wake the agent onto it. Mirrors the web
    // console's requestReconnect: drop the curtain, flip the row back to
    // active/view, then queue wake_agent carrying the session id so the agent
    // rejoins this session instead of waiting for a new invite.
    [RelayCommand]
    private async Task ReconnectAgent()
    {
        StopCurtainHeartbeat();
        CurtainOn = false;
        Mode = "view";
        TakenOver = false;
        try
        {
            await App.Api.PushInputAsync(SessionId, "curtain_off", new { }, CancellationToken.None);
            await App.Api.ResumeSessionAsync(SessionId, CancellationToken.None);
            await App.Api.EnqueuePowerCommandAsync(
                Device.RowId, "wake_agent", new { session_id = SessionId }, CancellationToken.None);
            StatusMessage = "Wake sent — waiting for the agent to rejoin this session.";
        }
        catch (SupabaseCallException ex) { SurfaceError(ex.Message); }
        catch (Exception ex) { SurfaceError(ex.Message); }
    }

    /// <summary>
    /// Single control/curtain toggle, matching the web console: taking control
    /// flips sessions.mode AND engages the curtain (plus its heartbeat);
    /// releasing does both in reverse. Splitting these was why the native
    /// console could hold "control" with no curtain, or a curtain that the
    /// agent watchdog dropped after 5s.
    /// </summary>
    [RelayCommand]
    private async Task ToggleControl()
    {
        var takeControl = Mode != "control";
        try
        {
            await App.Api.SetSessionModeAsync(SessionId, takeControl ? "control" : "view", CancellationToken.None);
            await App.Api.PushInputAsync(SessionId, takeControl ? "curtain_on" : "curtain_off",
                new { }, CancellationToken.None);
            Mode = takeControl ? "control" : "view";
            CurtainOn = takeControl;
            if (takeControl)
            {
                StartCurtainHeartbeat();
            }
            else
            {
                StopCurtainHeartbeat();
                await App.Api.PushInputAsync(SessionId, "release_inputs", new { }, CancellationToken.None);
            }
            StatusMessage = null;
        }
        catch (SupabaseCallException ex) { SurfaceError(ex.Message); }
        catch (Exception ex) { SurfaceError(ex.Message); }
    }

    public string ControlButtonLabel => Mode == "control" ? "Release curtain" : "Curtain (take control)";

    partial void OnModeChanged(string value) => OnPropertyChanged(nameof(ControlButtonLabel));
}

