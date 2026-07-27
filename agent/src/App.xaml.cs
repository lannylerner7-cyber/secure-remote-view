using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

public partial class App : Application
{
    private readonly CancellationTokenSource _cts = new();

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        string? apiUrl = null;
        for (int i = 0; i < e.Args.Length - 1; i++)
            if (e.Args[i] == "--api-url") { apiUrl = e.Args[i + 1]; ApiClient.SaveConfig(new ApiClient.AgentConfig(apiUrl)); }

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
                splash.Close();
                MessageBox.Show(
                    "This device is not enrolled with ConnectLive.\n\n" +
                    "Contact your administrator to install the ConnectLive package with a valid deployment key.\n\n" +
                    enrollEx.Message,
                    "ConnectLive Agent", MessageBoxButton.OK, MessageBoxImage.Warning);
                Shutdown();
                return;
            }

            // Auto-enrolled devices don't need a user-typed PIN. The admin
            // opens a session from the dashboard; the agent restores the
            // most recent binding on cold boot and otherwise idles.
            string? sessionId = null;
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
