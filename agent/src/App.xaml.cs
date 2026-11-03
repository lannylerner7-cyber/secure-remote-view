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
    private ApiClient? _api;
    private bool _authorizing;
    private bool _stopping;
    private System.Windows.Threading.DispatcherTimer? _withdrawalTimer;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        InputBlocker.LocalStopRequested += () => Dispatcher.BeginInvoke(new Action(DisableRemoteAccess));

        // An explicit local stop also works during an update handoff when no
        // Agent owns the tray yet. It never clears the withdrawal marker.
        var uninstalling = Array.Exists(e.Args, a => a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase));
        if (uninstalling || Array.Exists(e.Args, a => a.Equals("/disable", StringComparison.OrdinalIgnoreCase)))
        {
            try { LocalAccessState.Disable(); StartupConsent.Clear(); StartupSelfHeal.RemoveAll(); }
            catch { MessageBox.Show("Could not persist withdrawal. Uninstall ConnectLive or contact your IT administrator.", "ConnectLive"); }
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try { await CompanionAuthorization.ReportWithdrawalAsync(uninstalling, deadline.Token); }
            catch { Log.Warn("local withdrawal saved; lifecycle report unavailable"); }
            Shutdown();
            return;
        }
        var backgroundLaunch = Array.Exists(e.Args, a =>
            a.Equals("/BACKGROUND", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("--background", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("/WAKE", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("--wake", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("/MINIMIZED", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("--minimized", StringComparison.OrdinalIgnoreCase));
        // Check before enrollment, network, session restore or recovery.
        // Background/watchdog launches must not undo local withdrawal.
        if (backgroundLaunch && !StartupConsent.IsAllowed())
        {
            Shutdown();
            return;
        }

        if (UpdateEnvironment.Pending() && !UpdateEnvironment.AllowCandidate(e.Args, ApiClient.AgentVersion))
        {
            var recovering = UpdateEnvironment.StartRecovery(foregroundRepair: !backgroundLaunch);
            if (!backgroundLaunch) MessageBox.Show(recovering
                ? "Recovering an interrupted update. Open ConnectLive again after recovery. Remote permissions are unchanged."
                : "An interrupted update needs recovery. Remote access remains stopped; contact your IT administrator.",
                "ConnectLive update recovery");
            Shutdown();
            return;
        }
        _singleInstance = new Mutex(false, @"Global\ConnectLive.Agent");
        bool ownsMutex;
        try { ownsMutex = _singleInstance.WaitOne(0); }
        catch (AbandonedMutexException) { ownsMutex = true; }
        if (!ownsMutex)
        {
            // The running instance remains accessible from its taskbar window.
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

        // No grant prompts on background launch. Keep a taskbar status surface
        // available for local withdrawal and explicit foreground review.
        _splash = new SplashWindow();
        _splash.DisableAccessRequested += DisableRemoteAccess;
        _splash.AuthorizationRequested += ReviewAuthorization;
        _splash.Closing += (_, args) =>
        {
            if (_stopping) return;
            args.Cancel = true;
            // Defer shutdown until this Closing event has returned.
            Dispatcher.BeginInvoke(new Action(DisableRemoteAccess));
        };
        if (background) _splash.WindowState = WindowState.Minimized;
        _splash.Show();

        try
        {
            var api = new ApiClient(apiUrl);
            if (apiUrl != null) ApiClient.SaveConfig(new ApiClient.AgentConfig(api.ApiBaseUrl));
            _api = api;
            // Only foreground launches can surface the pairing disclosure. A
            // /BACKGROUND or /WAKE start with no prior enrollment must stay silent
            // and simply defer until the user opens the agent themselves.
            if (!background && !wake)
            {
                api.PairingProvider = (ct) => PairingPrompt.ShowAsync(api, ct);
            }
            api.OnLicenseChanged += OnLicenseChanged;
            var dispatcher = new WpfDispatcher(Current.Dispatcher);

            _splash?.SetStatus("Registering with ConnectLive…");
            var enrolled = await EnrollmentRetry.RunAsync(
                api.EnrollIfNeededAsync,
                () => !_stopping && ((!background && !wake) || !LocalAccessState.IsDisabled()),
                ex =>
                {
                    Log.Warn($"startup enrollment retry: {ex.Message}");
                    _splash?.SetStatus("Waiting for network — registration will retry…");
                },
                _cts.Token);
            // Never enter foreground agreement or start the Agent after local
            // withdrawal/shutdown during an attempt or asynchronous retry delay.
            if (!enrolled || _stopping || _cts.IsCancellationRequested) return;
            // Later authentication failures must not silently re-enroll or
            // interrupt an active session with another enrollment window.
            api.PairingProvider = null;
            api.LocalAuthorization = GrantStore.Load();
            if (!background && !wake && (LocalAccessState.IsDisabled() ||
                api.LocalAuthorization == null || api.LocalAuthorization.DeviceId != api.DeviceId ||
                api.LocalAuthorization.Origin != LocalGrant.OriginOf(api.ApiBaseUrl)))
            {
                var agreement = AuthorizationPrompt.Ask(LocalGrant.OriginOf(api.ApiBaseUrl), api.DeviceId!);
                if (agreement != null)
                {
                    await api.RecordAuthorizationAsync(agreement.Value.Mode, agreement.Value.Scopes, _cts.Token);
                    StartupConsent.Save(api.LocalAuthorization!, agreement.Value.Startup);
                    LocalAccessState.CompleteForegroundReauthorization();
                }
                else
                {
                    DisableRemoteAccess();
                    return;
                }
            }
            _splash?.SetStatus("Registering with ConnectLive…");

            // A local opt-in, not enrollment alone, authorizes startup/recovery.
            try { StartupSelfHeal.EnsureAll(); } catch { }

            _splash?.SetDevice(api.DeviceId ?? "not enrolled");

            // Session bindings and /SESSION flags are not consent evidence.
            // Only fresh heartbeat authority and local acceptance can start work.
            ApiClient.ClearSessionBinding();
            _splash?.SetStatus(api.LocalAuthorization == null ? "Authorization required — open ConnectLive in the foreground" : "Standing by");
            _splash?.SetSession("No active session");

            if (_stopping || _cts.IsCancellationRequested) return;
            // Status remains available without stealing focus on each wake.
            if (api.LocalAuthorization != null) _splash?.MinimizeToTray();
            _agent = new Agent(api, s => _splash?.SetStatus(s), dispatcher, onWake: null);
            _agent.SessionStateChanged += OnSessionStateChanged;
            _withdrawalTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _withdrawalTimer.Tick += (_, _) =>
            {
                if (LocalAccessState.IsDisabled() || InstallationLifecycle.RemovalRequested()) DisableRemoteAccess();
            };
            _withdrawalTimer.Start();

            // Heartbeat runs for the full application lifetime.
            await _agent.RunAsync(_cts.Token);
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested || _stopping)
        {
            // Local Disable/Close/Exit cancels enrollment and its retry delay.
        }
        catch (OperationCanceledException)
        {
            // Dismissing pairing is not an offline failure. Do not repeatedly
            // reopen a local enrollment prompt as a background recovery action.
            _splash?.SetStatus("Pairing required — open ConnectLive in the foreground");
        }
        catch (Exception ex)
        {
            Log.Warn($"startup: {ex.Message}");
            _splash?.SetStatus($"Error: {ex.Message}");
        }
    }

    private void OnSessionStateChanged(string state)
    {
        try { Current?.Dispatcher.Invoke(() => _splash?.SetSession(state)); } catch { }
    }

    private async void ReviewAuthorization()
    {
        if (_stopping || _authorizing || _api?.DeviceId == null) return;
        _authorizing = true;
        _agent?.SuspendForAuthorization();
        try
        {
            var agreement = AuthorizationPrompt.Ask(LocalGrant.OriginOf(_api.ApiBaseUrl), _api.DeviceId);
            if (agreement == null)
            {
                DisableRemoteAccess();
                return;
            }
            await _api.RecordAuthorizationAsync(agreement.Value.Mode, agreement.Value.Scopes, _cts.Token);
            if (_stopping || _cts.IsCancellationRequested) return;
            StartupConsent.Save(_api.LocalAuthorization!, agreement.Value.Startup);
            LocalAccessState.CompleteForegroundReauthorization();
            StartupSelfHeal.EnsureAll();
            _agent?.ResumeAfterAuthorization();
            _splash?.MinimizeToTray();
        }
        catch (Exception ex) { _splash?.SetStatus($"Authorization failed: {ex.Message}"); }
        finally { _authorizing = false; }
    }

    private async void DisableRemoteAccess()
    {
        if (_stopping) return;
        _stopping = true;
        // Stop live channels first: neither disk IO nor a network request may
        // delay withdrawal. Persistence is then attempted before process exit.
        try { _agent?.StopLocally(); } catch { }
        _cts.Cancel();
        bool saved = true;
        try
        {
            LocalAccessState.Disable();
            StartupConsent.Clear();
        }
        catch (Exception)
        {
            saved = false;
        }
        if (!saved)
        {
            // Do not falsely report persistence if the disk/ACL prevents it.
            MessageBox.Show("This agent is stopping, but Windows could not save the disabled state. Uninstall the agent to prevent a later restart.",
                "ConnectLive — could not save withdrawal", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        StartupSelfHeal.RemoveAll();
        using (var reportDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(3)))
        {
            try { await CompanionAuthorization.ReportWithdrawalAsync(InstallationLifecycle.RemovalRequested(), reportDeadline.Token); }
            catch { Log.Warn("local withdrawal saved; lifecycle report unavailable"); }
        }
        // Best effort only; local invalidation above never depends on network.
        if (_api != null)
        {
            using var revokeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try { await _api.RevokeAuthorizationAsync(revokeTimeout.Token); }
            catch (Exception ex) { Log.Warn($"local withdrawal saved; server revoke unavailable: {ex.Message}"); }
        }
        Shutdown();
    }

    /// <summary>
    /// Dormancy UX. The agent never nags: a blocked/expired license only
    /// changes the wording on the splash (while it is still visible) and the
    /// log. The machine stays enrolled and keeps heartbeating, so it revives
    /// the instant a seat frees or the subscription renews.
    /// </summary>
    private void OnLicenseChanged(ApiClient.LicenseState lic)
    {
        var text = lic.State switch
        {
            "active" => lic.MeetingId is { Length: > 0 } m ? $"Licensed — Meeting {m}" : "Licensed",
            "expired" => "Subscription expired — renew to resume support",
            "blocked" => lic.Reason == "seat_limit"
                ? "All seats in use — remove a device in your portal"
                : "Device not activated on this license",
            _ => null,
        };
        if (text is null) return;
        Log.Warn($"license: {lic.State} ({lic.Reason ?? "-"})");
        try { Current?.Dispatcher.Invoke(() => _splash?.SetStatus(text)); } catch { }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _withdrawalTimer?.Stop();
        _cts.Cancel();
        try { _agent?.StopLocally(); } catch { }
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
