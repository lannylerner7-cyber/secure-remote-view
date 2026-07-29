using System;
using System.Threading;
using System.Windows;
using ConnectLive.Admin.Api;
using ConnectLive.Admin.Views;

namespace ConnectLive.Admin;

public partial class App : Application
{
    private static Mutex? _singleInstanceMutex;
    public static AppConfig Config { get; private set; } = null!;
    public static ApiClient Api { get; private set; } = null!;
    public static AuthStore Auth { get; private set; } = null!;

    /// <summary>
    /// Stable per-install routing tag for this physical admin box. Present
    /// on every session/signal write so the agent can tell two admin
    /// machines apart when the same technician is signed in on both.
    /// </summary>
    public static string ClientId { get; private set; } = "";

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Single instance
        _singleInstanceMutex = new Mutex(true, "ConnectLiveAdmin.SingleInstance", out bool created);
        if (!created)
        {
            MessageBox.Show("ConnectLive Admin is already running.", "ConnectLive Admin",
                MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        try
        {
            Config = AppConfig.Load();
            Auth = new AuthStore();
            ClientId = ClientIdStore.LoadOrCreate();
            Api = new ApiClient(Config, Auth);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Failed to start: {ex.Message}", "ConnectLive Admin",
                MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
            return;
        }

        // If saved session is still valid, jump straight to main window. If
        // it's expired but we still hold a refresh_token, try a silent refresh
        // before falling back to the login window — this is what keeps the
        // admin console "always signed in" across reboots and long idles.
        if (Auth.HasValidSession())
        {
            new MainWindow().Show();
        }
        else if (Auth.Current != null && !string.IsNullOrEmpty(Auth.Current.RefreshToken))
        {
            try
            {
                var refreshed = Api.RefreshSessionAsync(CancellationToken.None).GetAwaiter().GetResult();
                if (refreshed && Auth.HasValidSession()) new MainWindow().Show();
                else new LoginWindow().Show();
            }
            catch { new LoginWindow().Show(); }
        }
        else
        {
            new LoginWindow().Show();
        }

    }

    protected override void OnExit(ExitEventArgs e)
    {
        _singleInstanceMutex?.ReleaseMutex();
        _singleInstanceMutex?.Dispose();
        base.OnExit(e);
    }
}
