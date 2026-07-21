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
            await api.EnrollIfNeededAsync(_cts.Token);
            splash.SetStatus("Ready");
            await Task.Delay(400);
            splash.Close();

            // Join window collects the 6-digit code from the dashboard.
            var join = new JoinWindow(api);
            var ok = join.ShowDialog();
            if (ok != true || string.IsNullOrEmpty(join.JoinedSessionId)) { Shutdown(); return; }

            var sessionId = join.JoinedSessionId!;

            // Tray + persistent banner + screen capture loop.
            _ = new TrayIcon(onQuit: Shutdown);
            var indicator = new SessionIndicator("Helpdesk", onEnd: () => _cts.Cancel());
            indicator.Show();
            InputRelay.SessionBanner = indicator;

            _ = ScreenCapture.RunAsync(api, sessionId, _cts.Token);
            _ = InputRelay.RunAsync(api, sessionId, _cts.Token);



            var agent = new Agent(api, _ => { }, dispatcher);
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
