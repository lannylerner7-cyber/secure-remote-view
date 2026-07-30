using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

public partial class App : Application
{
    private readonly CancellationTokenSource _cts = new();
    private Mutex? _singleInstance;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _singleInstance = new Mutex(true, @"Global\ConnectLive.Agent", out var firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("ConnectLive Agent is already running.", "ConnectLive Agent",
                MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        if (!IsWatcherServiceRunning())
        {
            MessageBox.Show(
                "ConnectLive background service is not running.\n\n" +
                "Please reinstall ConnectLive or contact your administrator.",
                "ConnectLive Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
            Shutdown();
            return;
        }

        string? apiUrl = null;
        string? wakeSessionId = null;
        bool wake = false;
        for (int i = 0; i < e.Args.Length; i++)
        {
            var a = e.Args[i];
            if (a == "--api-url" && i + 1 < e.Args.Length)
            {
                apiUrl = e.Args[i + 1];
                ApiClient.SaveConfig(new ApiClient.AgentConfig(apiUrl));
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

        // Watcher-triggered stop signal: if the Boss drops stop.flag, exit cleanly.
        StopFlagWatcher.Start(_cts.Token);


        var splash = new SplashWindow();
        splash.Show();

        var api = new ApiClient(apiUrl);
        var dispatcher = new WpfDispatcher(Application.Current.Dispatcher);

        try
        {
            splash.SetStatus("Registering with ConnectLive…");
            try
            {
                await api.EnrollIfNeededAsync(_cts.Token);
            }
            catch (Exception enrollEx)
            {
                // Auto-enroll is retried by the Watcher heartbeat loop on the
                // next tick, so a transient network hiccup is not fatal — we
                // just close the splash and let the tray icon indicate state.
                splash.Close();
                MessageBox.Show(
                    "ConnectLive Agent couldn't reach the registration service.\n\n" +
                    "It will retry automatically. Details:\n" + enrollEx.Message,
                    "ConnectLive Agent", MessageBoxButton.OK, MessageBoxImage.Information);
                Shutdown();
                return;
            }


            // Boss (Watcher) → Worker (Agent) handoff: if /WAKE was passed
            // with a /SESSION=<id>, treat that id as authoritative and skip
            // the disk-restore lookup.
            string? sessionId = null;
            if (wake && !string.IsNullOrWhiteSpace(wakeSessionId))
            {
                sessionId = wakeSessionId;
                splash.SetStatus("Attaching to session…");
            }
            else
            {
                var saved = api.LoadSessionBinding();
                if (saved is not null && !string.IsNullOrWhiteSpace(saved.SessionId))
                {
                    splash.SetStatus("Restoring previous session…");
                    var restored = await api.ReconnectSessionAsync(saved.SessionId, saved.PairingCode, _cts.Token);
                    if (restored.Ok && !string.IsNullOrEmpty(restored.SessionId))
                        sessionId = restored.SessionId;
                    else
                        ApiClient.ClearSessionBinding();
                }
            }

            splash.SetStatus(sessionId is null ? "Standing by" : "Session restored");
            await Task.Delay(400);
            splash.Close();

            // One unified path: Agent owns the session lifecycle (invite consent
            // + frame/input/cursor loops + WebRTC upgrade). On cold-boot with a
            // restored session, seed it so Agent joins immediately without
            // re-prompting for consent.
            _ = new TrayIcon(onQuit: Shutdown);
            var agent = new Agent(api, _ => { }, dispatcher);
            if (!string.IsNullOrEmpty(sessionId))
                agent.SeedRestoredSession(sessionId!);
            await agent.RunAsync(_cts.Token);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"ConnectLive Agent failed to start:\n\n{ex.Message}",
                "ConnectLive Agent", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _cts.Cancel();
        try { _singleInstance?.ReleaseMutex(); } catch { }
        _singleInstance?.Dispose();
        base.OnExit(e);
    }

    /// <summary>
    /// Read-only status probe. The Watcher is a LocalSystem Windows Service
    /// registered by the installer — the Agent must never try to start,
    /// repair, or spawn it. Doing so would create a child process owned by
    /// the interactive user, and WTSQueryUserToken inside the Watcher would
    /// then fail with access-denied on every tick.
    /// </summary>
    private static bool IsWatcherServiceRunning()
    {
        try
        {
            using var sc = new ServiceController("ConnectLiveWatcher");
            return sc.Status == ServiceControllerStatus.Running;
        }
        catch
        {
            return false;
        }
    }
}

internal sealed class WpfDispatcher : Dispatcher
{
    private readonly System.Windows.Threading.Dispatcher _d;
    public WpfDispatcher(System.Windows.Threading.Dispatcher d) => _d = d;
    public void Invoke(Action a) => _d.Invoke(a);
    public Task<T> InvokeAsync<T>(Func<T> a) => _d.InvokeAsync(a).Task;
}
