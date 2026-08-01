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

        // No stop.flag any more: quitting the Agent only ends the current
        // process. The three logon triggers bring it back at next sign-in.

        SplashWindow? splash = null;
        if (!background)
        {
            splash = new SplashWindow();
            splash.Show();
        }

        var api = new ApiClient(apiUrl);
        var dispatcher = new WpfDispatcher(Current.Dispatcher);

        // Status window exists for the process lifetime; only ever shown on a
        // foreground (double-click / Start Menu) launch.
        _main = new MainWindow();

        try
        {
            splash?.SetStatus("Registering with ConnectLive…");
            _main.SetLink("Connecting…");

            // Self-persistence: three redundant logon triggers (HKCU Run key,
            // Startup folder shortcut, Scheduled Task) — re-asserted every
            // launch. Dev-path guard inside means a Downloads/dist run never
            // clobbers an installed machine's autostart. Enrollment itself is
            // boot-proof: Agent.RunAsync retries forever so a "Windows Startup
            // fired before Wi-Fi came up" boot doesn't strand the Agent.
            try { StartupSelfHeal.EnsureAll(); } catch { }

            _main.SetDevice(api.DeviceId ?? "not enrolled");

            // Explicit /SESSION=<id> wins; otherwise restore the last session
            // binding from the hidden local store. The Agent never creates a
            // session on its own.
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
                // Progressive splash: hold the full ~5s so a foreground launch
                // reads as a real application start, then go quiet.
                await Task.Delay(1200);
                splash.Close();
            }

            _main.SetLink(string.IsNullOrEmpty(api.DeviceToken) ? "Waiting for network" : "Connected");
            _main.SetSession(sessionId is null ? "No active session" : $"Session {sessionId}");

            if (!background)
                _main.ShowAndActivate();

            // One unified path: Agent owns the session lifecycle (invite pickup
            // + frame/input/cursor loops + WebRTC upgrade). On cold-boot with a
            // restored session, seed it so Agent joins immediately.
            _agent = new Agent(api, s => _main?.SetLink(s), dispatcher, onWake: SurfaceUi);
            _agent.SessionStateChanged += OnSessionStateChanged;
            if (!string.IsNullOrEmpty(sessionId))
                _agent.SeedRestoredSession(sessionId!);

            // Standalone build: heartbeat long-poll is the single transport.
            // No SSE listener, no helper service — the Agent is self-contained.

            // Heartbeat runs for the full application lifetime, independent of
            // any window being visible.
            await _agent.RunAsync(_cts.Token);
        }
        catch (Exception ex)
        {
            Log.Warn($"startup: {ex.Message}");
            _main?.SetLink($"Error: {ex.Message}");
        }
    }

    private void OnSessionStateChanged(string state) => _main?.SetSession(state);

    /// <summary>Admin pressed Connect — bring the status window forward.</summary>
    private void SurfaceUi()
    {
        try { Current?.Dispatcher.Invoke(() => _main?.ShowAndActivate()); } catch { }
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
