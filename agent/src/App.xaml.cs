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

        // Optional --api-url override on first run.
        string? apiUrl = null;
        for (int i = 0; i < e.Args.Length - 1; i++)
            if (e.Args[i] == "--api-url") { apiUrl = e.Args[i + 1]; ApiClient.SaveConfig(new ApiClient.AgentConfig(apiUrl)); }

        var splash = new SplashWindow();
        splash.Show();

        var api = new ApiClient(apiUrl);
        var dispatcher = new WpfDispatcher(Application.Current.Dispatcher);
        var agent = new Agent(api, status => splash.SetStatus(status), dispatcher);

        try
        {
            // Run bootstrap: enroll -> heartbeat -> open realtime channel.
            // Once the WS is up we hide the splash and stay resident in the tray.
            var bootstrap = agent.RunAsync(_cts.Token);
            await Task.WhenAny(bootstrap, Task.Delay(2500));
            splash.SetStatus("Connected — waiting for helpdesk");
            await Task.Delay(600);
            splash.Close();

            // Tray icon lives for the process lifetime.
            _ = new TrayIcon(onQuit: Shutdown);
            await bootstrap; // keep alive
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
