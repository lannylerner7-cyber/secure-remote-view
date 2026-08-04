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

    // Pixel size of the most recent JPEG-path frame. This is the rung readout
    // for the fallback transport: when the agent's BitrateController steps
    // down, the source arrives smaller and the picture goes soft — the bar has
    // to say so instead of letting it look like a renderer bug.
    private int _jpegW, _jpegH;

    partial void OnCurrentFrameChanged(System.Windows.Media.ImageSource? value)
    {
        // Only a BitmapSource is a JPEG-path frame. When the WebRTC pipeline
        // swaps in a D3DImage (or the surface is cleared) the cached size must
        // go with it, or a connected-but-not-yet-presenting session would
        // report the last fallback frame's dimensions as if they were live.
        if (value is BitmapSource bs) { _jpegW = bs.PixelWidth; _jpegH = bs.PixelHeight; }
        else { _jpegW = _jpegH = 0; }
    }

    [ObservableProperty] private string linkState = "connecting";

    /// <summary>
    /// S16 — HWND of the window presenting this session, supplied by the view
    /// before <see cref="Start"/>. The D3D device is associated with it; the
    /// old MainWindow fallback bound the device to the device list and gave a
    /// black picture on some drivers.
    /// </summary>
    public IntPtr PresentationWindow { get; set; }

    /// <summary>S16 — set when the native decode path retired itself; shown in the stats pill.</summary>
    private string? _nativeUnavailable;

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

        // SCOPE:CAPTURE — keep the monitor picker in step with hot-plug /
        // undock events reported by the agent heartbeat.
        SeedMonitors(Device.Monitors, Device.SelectedMonitor);
        StartMonitorPolling(_cts.Token);



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
                        PublishCursor(CursorNormX, CursorNormY, false);
                        return;
                    }
                    PublishCursor(
                        Math.Clamp((double)e.X / e.FrameW.Value, 0, 1),
                        Math.Clamp((double)e.Y / e.FrameH.Value, 0, 1),
                        true);
                });
            },

            onError: SurfaceError,
            onHealth: healthy => _realtimeHealthy = healthy);
        _realtime.Start();

        _rtc = new WebRtcClient(SessionId);
        _rtc.Pipeline.PresentationWindow = PresentationWindow;

        // S16 — if the native path can never produce a picture (no VP8 decoder,
        // or output we cannot convert), say exactly that instead of leaving the
        // technician staring at a "stalled" pill on a JPEG stream.
        _rtc.Pipeline.NativeVideoUnavailable += reason =>
        {
            _nativeUnavailable = reason;
            Application.Current?.Dispatcher.Invoke(() =>
            {
                NativeVideo = false;
                Transport = _realtimeHealthy ? "Realtime frames" : "Frame fallback";
                LinkState = "native video unavailable — " + reason;
            });
        };

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
                var presenting = p?.IsPresenting == true;
                // S11 — the bar reports the whole hop, not just the decoder:
                // render numbers, present path, media wire path, input path.
                // On the JPEG path there is no pipeline, but the source size
                // still has to be visible: it is the only on-screen evidence of
                // which adaptive rung the agent is encoding at.
                string? text;
                if (presenting && p != null)
                {
                    text = $"{p.Fps:F0} fps · {p.LastLatencyMs:F0} ms · q{p.QueueDepth} · {SourceLabel(p.SourceWidth, p.SourceHeight)} · {(p.UsingD3D ? "D3D" : "bitmap")} · wire {_rtc?.WirePath ?? "unknown"} · input {ConnectLive.Admin.Input.InputTransport.CurrentPath}";
                }
                else if (_jpegW > 0 && _jpegH > 0)
                {
                    // S16 — on the JPEG path, name the reason. "decoder
                    // unavailable" and "no relay" are the two answers that used
                    // to be missing, and they are the two that decide whether
                    // this is a client problem or a network problem.
                    var why = _nativeUnavailable ?? (_rtc != null && !_rtc.HasRelay ? "no relay (STUN only)" : null);
                    text = $"{SourceLabel(_jpegW, _jpegH)} · jpeg" +
                           (why != null ? $" · {why}" : "") +
                           $" · input {ConnectLive.Admin.Input.InputTransport.CurrentPath}";
                }
                else
                {
                    text = _nativeUnavailable;
                }

                Application.Current?.Dispatcher.InvokeAsync(() =>
                {
                    VideoStats = text;
                    if (!presenting && NativeVideo)
                    {
                        NativeVideo = false;
                        Transport = _realtimeHealthy ? "Realtime frames" : "Frame fallback";
                    }
                    // S15(a) — the pill must be honest in BOTH directions. The
                    // first-frame callback fires once, so a recovered stream
                    // (keyframe after loss, ICE restart) used to stay labelled
                    // "fallback" while native frames were plainly on screen.
                    else if (presenting && !NativeVideo)
                    {
                        NativeVideo = true;
                        Transport = "Native video";
                        LinkState = "live";
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

    // Mirrors agent/src/BitrateController.cs Ladder max-edge values so a soft
    // picture reads as "the link stepped the encoder down", not "the renderer
    // is broken". Index 0 is the sharpest rung.
    private static readonly int[] RungEdges = { 1920, 1600, 1280, 1024, 800, 640 };

    private static string SourceLabel(int w, int h)
    {
        if (w <= 0 || h <= 0) return "—";
        var edge = Math.Max(w, h);
        var idx = -1;
        for (var i = 0; i < RungEdges.Length; i++)
        {
            // Allow a little slack: the agent rounds to even dimensions.
            if (Math.Abs(RungEdges[i] - edge) <= 8) { idx = i; break; }
        }
        return idx >= 0
            ? $"{w}x{h} · rung {idx}/{RungEdges.Length - 1}"
            : $"{w}x{h}";
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
        _jpegW = _jpegH = 0;
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

    partial void OnModeChanged(string value)
    {
        OnPropertyChanged(nameof(ControlButtonLabel));
        OnPropertyChanged(nameof(InputAuthoritative));
    }

    // SCOPE:RENDER — the predictive cursor listens on InputAuthoritative, so
    // every input on which it depends must republish it.
    partial void OnCurtainOnChanged(bool value) => OnPropertyChanged(nameof(InputAuthoritative));
    partial void OnTakenOverChanged(bool value) => OnPropertyChanged(nameof(InputAuthoritative));

    // ---------------------------------------------------------------------
    // SCOPE:CAPTURE — multi-monitor picker
    //
    // The agent publishes its attached-display inventory on every heartbeat
    // (devices.metadata.monitors) and MonitorSelector on the agent is the one
    // authority for "which display are we capturing". So the picker is a pure
    // mirror: we render what the agent reported, and a user pick enqueues a
    // `switch_monitor` power command. We do NOT optimistically rewrite the
    // selection — the next heartbeat is what confirms it, exactly like the
    // curtain state. That's why _applyingRemote guards the setter: without it
    // the incoming confirmation would re-fire the command in a loop.
    // ---------------------------------------------------------------------

    public System.Collections.ObjectModel.ObservableCollection<MonitorOption> Monitors { get; } = new();

    [ObservableProperty] private MonitorOption? selectedMonitor;

    /// <summary>Picker only earns screen space when there's a real choice.</summary>
    public bool HasMultipleMonitors => Monitors.Count > 1;

    private bool _applyingRemote;

    private void SeedMonitors(System.Collections.Generic.IReadOnlyList<MonitorOption> monitors, string? selected)
    {
        _applyingRemote = true;
        try
        {
            // Rebuild only when the inventory actually changed; ComboBox loses
            // an open drop-down on every Clear().
            bool same = Monitors.Count == monitors.Count;
            if (same)
            {
                for (int i = 0; i < monitors.Count; i++)
                {
                    if (!string.Equals(Monitors[i].DeviceName, monitors[i].DeviceName, StringComparison.OrdinalIgnoreCase))
                    { same = false; break; }
                }
            }
            if (!same)
            {
                Monitors.Clear();
                foreach (var m in monitors) Monitors.Add(m);
                OnPropertyChanged(nameof(HasMultipleMonitors));
            }

            MonitorOption? match = null;
            foreach (var m in Monitors)
            {
                if (!string.IsNullOrEmpty(selected) &&
                    string.Equals(m.DeviceName, selected, StringComparison.OrdinalIgnoreCase))
                { match = m; break; }
                if (match == null && m.IsPrimary) match = m;
            }
            if (match == null && Monitors.Count > 0) match = Monitors[0];
            if (!ReferenceEquals(match, SelectedMonitor)) SelectedMonitor = match;
        }
        finally { _applyingRemote = false; }
    }

    private void StartMonitorPolling(CancellationToken ct)
    {
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try { await Task.Delay(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false); }
                catch { return; }
                try
                {
                    var row = await App.Api.GetDeviceAsync(Device.RowId, ct).ConfigureAwait(false);
                    if (row == null) continue;
                    var (monitors, selected) = MonitorMetadata.Parse(row.Metadata);
                    if (monitors.Count == 0) continue;
                    Application.Current?.Dispatcher.Invoke(() => SeedMonitors(monitors, selected));
                }
                catch (OperationCanceledException) { return; }
                catch { /* transient: next tick retries */ }
            }
        }, ct);
    }

    partial void OnSelectedMonitorChanged(MonitorOption? value)
    {
        if (_applyingRemote || value == null) return;
        _ = SwitchMonitorAsync(value);
    }

    private async Task SwitchMonitorAsync(MonitorOption target)
    {
        try
        {
            await App.Api.EnqueuePowerCommandAsync(
                Device.RowId, "switch_monitor",
                new { device_name = target.DeviceName, index = target.Index },
                CancellationToken.None);
            StatusMessage = $"Switching capture to {target.Label}…";
            // A monitor change invalidates every buffered frame and the encoder's
            // reference chain, so force a fresh stream rather than showing torn
            // pixels from the previous display's resolution.
            try
            {
                await App.Api.EnqueuePowerCommandAsync(
                    Device.RowId, "restart_stream", new { }, CancellationToken.None);
            }
            catch { /* best-effort; the agent also rebuilds on SelectionChanged */ }
        }
        catch (SupabaseCallException ex) { SurfaceError(ex.Message); }
        catch (Exception ex) { SurfaceError(ex.Message); }
    }
}


