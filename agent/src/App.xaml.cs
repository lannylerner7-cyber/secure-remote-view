using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

public partial class App : Application
{
    private readonly CancellationTokenSource _cts = new();
    private Mutex? _singleInstance;
    private MainWindow? _main;
    private TrayIcon? _tray;
    private Agent? _agent;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _singleInstance = new Mutex(true, @"Global\ConnectLive.Agent", out var firstInstance);
        if (!firstInstance)
        {
            // A second launch just surfaces the running instance's tray presence.
            Shutdown();
            return;
        }

        string? apiUrl = null;
        string? wakeSessionId = null;
        bool wake = false;
        bool background = false;
        for (int i = 0; i < e.Args.Length; i++)
        {
            var a = e.Args[i];
            if (a == "--api-url" && i + 1 < e.Args.Length)
            {
                apiUrl = e.Args[i + 1];
                ApiClient.SaveConfig(new ApiClient.AgentConfig(apiUrl));
            }
            else if (string.Equals(a, "/BACKGROUND", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(a, "--background", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(a, "/MINIMIZED", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase))
            {
                background = true;
            }
            else if (string.Equals(a, "/WAKE", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(a, "--wake",  StringComparison.OrdinalIgnoreCase))
            {
                wake = true;
            }
            else if (a.StartsWith("/SESSION=", StringComparison.OrdinalIgnoreCase))
            {
                wakeSessionId = a.Substring("/SESSION=".Length).Trim('"');
            }
            else if (string.Equals(a, "--session", StringComparison.OrdinalIgnoreCase) && i + 1 < e.Args.Length)
            {
                wakeSessionId = e.Args[i + 1];
            }
        }

        // User-quit override. An automatic launch (Run key / Watcher) must respect
        // a previous explicit Exit; a manual launch clears it.
        if (StopFlagWatcher.Exists())
        {
            if (background)
            {
                Log.Info("stop.flag present — automatic launch suppressed");
                Shutdown();
                return;
            }
            StopFlagWatcher.Clear();
        }

        StopFlagWatcher.Start(_cts.Token);

        SplashWindow? splash = null;
        if (!background)
        {
            splash = new SplashWindow();
            splash.Show();
        }

        var api = new ApiClient(apiUrl);
        var dispatcher = new WpfDispatcher(Current.Dispatcher);

        // The status window exists for the whole process lifetime; it is only
        // shown in foreground launches (or on an admin wake).
        _main = new MainWindow();
        _tray = new TrayIcon(onShowWindow: () => _main?.ShowAndActivate(), onExit: ExitApplication);

        try
        {
            splash?.SetStatus("Registering with ConnectLive…");
            _main.SetLink("Connecting…");

            // Self-persistence: HKCU Run key is idempotent and safe pre-enroll.
            // Enrollment itself is boot-proof: Agent.RunAsync retries forever
            // so a "Windows Startup fired before Wi-Fi came up" boot doesn't
            // strand the Agent offline permanently.
            try { StartupRegistration.RegisterStartupWithWindows(); } catch { }

            _main.SetDevice(api.DeviceId ?? "not enrolled");

            // Boss (Watcher) → Worker (Agent) handoff: if /WAKE was passed
            // with a /SESSION=<id>, treat that id as authoritative and skip
            // the disk-restore lookup.
            string? sessionId = null;
            if (wake && !string.IsNullOrWhiteSpace(wakeSessionId))
            {
                sessionId = wakeSessionId;
                splash?.SetStatus("Attaching to session…");
            }
            else if (!string.IsNullOrEmpty(api.DeviceToken))
            {
                var saved = api.LoadSessionBinding();
                if (saved is not null && !string.IsNullOrWhiteSpace(saved.SessionId))
                {
                    splash?.SetStatus("Restoring previous session…");
                    try
                    {
                        var restored = await api.ReconnectSessionAsync(saved.SessionId, saved.PairingCode, _cts.Token);
                        if (restored.Ok && !string.IsNullOrEmpty(restored.SessionId))
                            sessionId = restored.SessionId;
                        else
                            ApiClient.ClearSessionBinding();
                    }
                    catch (Exception ex) { Log.Warn($"session restore: {ex.Message}"); }
                }
            }

            splash?.SetStatus(sessionId is null ? "Standing by" : "Session restored");
            if (splash is not null)
            {
                await Task.Delay(400);
                splash.Close();
            }

            _main.SetLink(string.IsNullOrEmpty(api.DeviceToken) ? "Waiting for network" : "Connected");
            _main.SetSession(sessionId is null ? "No active session" : $"Session {sessionId}");
            _tray.SetStatus(sessionId is null ? "standing by" : "session active");

            if (!background)
                _main.ShowAndActivate();

            // One unified path: Agent owns the session lifecycle (invite consent
            // + frame/input/cursor loops + WebRTC upgrade). On cold-boot with a
            // restored session, seed it so Agent joins immediately without
            // re-prompting for consent.
            _agent = new Agent(api, s => _main?.SetLink(s), dispatcher, onWake: SurfaceUi);
            _agent.SessionStateChanged += OnSessionStateChanged;
            if (!string.IsNullOrEmpty(sessionId))
                _agent.SeedRestoredSession(sessionId!);

            // SSE accelerator: sub-second wake when the admin hits Connect.
            // Hand the listener to Agent so the heartbeat cadence relaxes to
            // 60s while SSE is healthy and snaps back to 5s when it drops.
            var stream = new StreamListener(api, () => _agent?.RequestWake());
            _agent.Stream = stream;
            stream.Start(_cts.Token);

            // Heartbeat runs for the full application lifetime, independent of
            // any window being visible.
            await _agent.RunAsync(_cts.Token);
        }

        catch (Exception ex)
        {
            Log.Warn($"startup: {ex.Message}");
            _main?.SetLink($"Error: {ex.Message}");
            _tray?.SetStatus("error");
        }
    }

    private void OnSessionStateChanged(string state)
    {
        _main?.SetSession(state);
        _tray?.SetStatus(state);
    }

    /// <summary>Admin pressed Connect — bring the Agent UI to the foreground.</summary>
    private void SurfaceUi()
    {
        try { Current?.Dispatcher.Invoke(() => _main?.ShowAndActivate()); } catch { }
    }

    /// <summary>The only explicit quit path (tray → Exit).</summary>
    private void ExitApplication()
    {
        StopFlagWatcher.Write();
        Current?.Dispatcher.Invoke(() =>
        {
            if (_main is not null) _main.HideInsteadOfClose = false;
            Shutdown();
        });
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _cts.Cancel();
        try { _tray?.Dispose(); } catch { }
        try { _singleInstance?.ReleaseMutex(); } catch { }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}

internal sealed class WpfDispatcher : Dispatcher
{
    private readonly System.Windows.Threading.Dispatcher _d;
    public WpfDispatcher(System.Windows.Threading.Dispatcher d) => _d = d;
    public void Invoke(Action a) => _d.Invoke(a);
    public Task<T> InvokeAsync<T>(Func<T> a) => _d.InvokeAsync(a).Task;
}
