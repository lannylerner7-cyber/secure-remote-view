using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using ConnectLive.Admin.Api;
using ConnectLive.Admin.Diag;
using ConnectLive.Admin.Views;

namespace ConnectLive.Admin;

public partial class App : Application
{
    private static Mutex? _singleInstanceMutex;
    private static bool _mutexOwned;

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

        // ---- 0. Never fail silently again -------------------------------
        DispatcherUnhandledException += (_, args) =>
        {
            Log.Error("DispatcherUnhandledException", args.Exception);
            ShowFatal(args.Exception);
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (args.ExceptionObject is Exception ex) Log.Error("AppDomain.UnhandledException", ex);
            else Log.Write("ERROR AppDomain.UnhandledException: " + args.ExceptionObject);
        };
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Log.Error("UnobservedTaskException", args.Exception);
            args.SetObserved();
        };

        Log.Write("---- startup ----");

        // ---- 1. Single instance ----------------------------------------
        try
        {
            _singleInstanceMutex = new Mutex(true, @"Local\ConnectLiveAdmin.SingleInstance", out _mutexOwned);
            if (!_mutexOwned)
            {
                // Another live instance already owns the mutex. Wait a beat in
                // case a previous process is mid-shutdown before giving up.
                _mutexOwned = _singleInstanceMutex.WaitOne(TimeSpan.FromSeconds(2));
            }
        }
        catch (AbandonedMutexException)
        {
            // Previous instance died without releasing — we now own it.
            _mutexOwned = true;
        }
        catch (Exception ex)
        {
            Log.Error("mutex", ex);
            _mutexOwned = true; // never block startup on the guard itself
        }

        if (!_mutexOwned)
        {
            Log.Write("another instance is running — exiting");
            MessageBox.Show("ConnectLive Admin is already running.", "ConnectLive Admin",
                MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        // ---- 2. Bootstrap services -------------------------------------
        try
        {
            Config = AppConfig.Load();
            Log.Write($"config loaded: baseUrl={Config.BaseUrl}");
            Auth = new AuthStore();
            ClientId = ClientIdStore.LoadOrCreate();
            Log.Write($"client id: {ClientId}");
            Api = new ApiClient(Config, Auth);
        }
        catch (Exception ex)
        {
            Log.Error("bootstrap", ex);
            MessageBox.Show($"Failed to start: {ex.Message}\n\nLog: {Log.FilePath}",
                "ConnectLive Admin", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
            return;
        }

        // ---- 3. Always show a window immediately ------------------------
        // NOTHING on this path may block the dispatcher. The old code called
        // RefreshSessionAsync().GetAwaiter().GetResult() here, which deadlocked
        // the UI thread on a slow link: the process ran with no window and no
        // error. The refresh now happens after the window is up.
        if (Auth.HasValidSession())
        {
            Log.Write("valid saved session — opening main window");
            ShowMain();
            return;
        }

        var login = new LoginWindow();
        MainWindow = login;
        login.Show();
        Log.Write("login window shown");

        if (Auth.Current != null && !string.IsNullOrEmpty(Auth.Current.RefreshToken))
        {
            Log.Write("attempting silent refresh in background");
            _ = TrySilentRefreshAsync(login);
        }
    }

    private static async Task TrySilentRefreshAsync(Window login)
    {
        bool ok = false;
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            ok = await Task.Run(() => Api.RefreshSessionAsync(cts.Token)).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log.Error("silent refresh", ex);
        }

        if (!ok || !Auth.HasValidSession())
        {
            Log.Write("silent refresh failed — staying on login window");
            return;
        }

        Log.Write("silent refresh succeeded — swapping to main window");
        Current?.Dispatcher.Invoke(() =>
        {
            // The technician may already have signed in manually while the
            // refresh was in flight — in that case leave the UI alone.
            if (!login.IsLoaded && !login.IsVisible) return;
            ShowMain();
            login.Close();
        });
    }

    private static void ShowMain()
    {
        var win = new MainWindow();
        Current.MainWindow = win;
        win.Show();
    }

    private static void ShowFatal(Exception ex)
    {
        try
        {
            MessageBox.Show(
                $"ConnectLive Admin hit an unexpected error:\n\n{ex.Message}\n\nDetails were written to:\n{Log.FilePath}",
                "ConnectLive Admin", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        catch { }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        Log.Write("---- exit ----");
        try { if (_mutexOwned) _singleInstanceMutex?.ReleaseMutex(); } catch { }
        _singleInstanceMutex?.Dispose();
        base.OnExit(e);
    }
}
