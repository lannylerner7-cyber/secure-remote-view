using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

public partial class App : Application
{
    private readonly CancellationTokenSource _cts = new();
    private Mutex? _singleInstance;
    private SplashWindow? _splash;
    private Agent? _agent;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _singleInstance = new Mutex(true, @"Global\ConnectLive.Agent", out var firstInstance);
        if (!firstInstance)
        {
            // Headless build: a second launch simply exits. The already-running
            // instance keeps its session; there is no tray surface to reveal.
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

        // Only visible surface: the ~5s splash on a foreground launch. It
        // doubles as the connection banner (device id + session). Wake and
        // background launches stay silent — no window, no tray, no toast.
        if (!background)
        {
            _splash = new SplashWindow();
            _splash.Show();
        }

        var api = new ApiClient(apiUrl);
        var dispatcher = new WpfDispatcher(Current.Dispatcher);

        try
        {
            _splash?.SetStatus("Registering with ConnectLive…");

            // Self-persistence: three redundant logon triggers (HKCU Run key,
            // Startup folder shortcut, Scheduled Task) — re-asserted every
            // launch. Dev-path guard inside means a Downloads/dist run never
            // clobbers an installed machine's autostart.
            try { StartupSelfHeal.EnsureAll(); } catch { }

            _splash?.SetDevice(api.DeviceId ?? "not enrolled");

            // Explicit /SESSION=<id> wins; otherwise restore the last session
            // binding from the hidden local store. The Agent never creates a
            // session on its own.
            string? sessionId = null;
            if (wake && !string.IsNullOrWhiteSpace(wakeSessionId))
            {
                sessionId = wakeSessionId;
                _splash?.SetStatus("Attaching to session…");
            }
            else if (!string.IsNullOrEmpty(api.DeviceToken))
            {
                var saved = api.LoadSessionBinding();
                if (saved is not null && !string.IsNullOrWhiteSpace(saved.SessionId))
                {
                    _splash?.SetStatus("Restoring previous session…");
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

            _splash?.SetStatus(sessionId is null ? "Standing by" : "Session restored");
            _splash?.SetSession(sessionId is null ? "No active session" : $"Session {sessionId}");

            // Progressive splash: hold ~5s so a foreground launch reads as a
            // real application start, then go quiet forever.
            if (_splash is not null)
            {
                _ = Task.Delay(TimeSpan.FromSeconds(5)).ContinueWith(_ =>
                    Current?.Dispatcher.Invoke(() =>
                    {
                        try { _splash?.Close(); } catch { }
                        _splash = null;
                    }), TaskScheduler.Default);
            }

            // Agent owns the session lifecycle end-to-end. onWake is a no-op:
            // wake events must never surface a window — they only cause the
            // agent to attach to the session in the background.
            _agent = new Agent(api, s => _splash?.SetStatus(s), dispatcher, onWake: null);
            _agent.SessionStateChanged += OnSessionStateChanged;
            if (!string.IsNullOrEmpty(sessionId))
                _agent.SeedRestoredSession(sessionId!);

            // Heartbeat runs for the full application lifetime.
            await _agent.RunAsync(_cts.Token);
        }
        catch (Exception ex)
        {
            Log.Warn($"startup: {ex.Message}");
            _splash?.SetStatus($"Error: {ex.Message}");
        }
    }

    private void OnSessionStateChanged(string state)
    {
        // Reflect state into the splash only while it is still visible; after
        // it auto-closes there is intentionally no surface to update.
        try { Current?.Dispatcher.Invoke(() => _splash?.SetSession(state)); } catch { }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _cts.Cancel();
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
