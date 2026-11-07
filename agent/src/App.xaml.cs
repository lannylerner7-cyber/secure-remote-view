using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

public partial class App : Application
{
    private readonly CancellationTokenSource _cts = new();
    private Mutex? _singleInstance;
    private Agent? _agent;
    private ApiClient? _api;
    private bool _stopping;
    private System.Windows.Threading.DispatcherTimer? _withdrawalTimer;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // Initialize the file log before any policy, update or duplicate-process exit.
        // Do not log command-line arguments: they may contain private configuration.
        Log.Info("startup entered; diagnostics initialized before pairing and session startup");

        // Local command-line withdrawal remains available without a second UI.
        // It also works during an update handoff and never clears the marker.
        var uninstalling = Array.Exists(e.Args, a => a.Equals("/uninstall", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("--uninstall", StringComparison.OrdinalIgnoreCase));
        if (uninstalling || Array.Exists(e.Args, a => a.Equals("/disable", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("--disable", StringComparison.OrdinalIgnoreCase)))
        {
            try { LocalAccessState.Disable(); UnlockEnrollment.Forget(); StartupConsent.Clear(); StartupSelfHeal.RemoveAll(); }
            catch
            {
                MessageBox.Show("Could not persist withdrawal. Uninstall ConnectLive or contact your IT administrator.", "ConnectLive");
                Shutdown(1);
                return;
            }
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try { await CompanionAuthorization.ReportWithdrawalAsync(uninstalling, deadline.Token); }
            catch { Log.Warn("local withdrawal saved; lifecycle report unavailable"); }
            Shutdown();
            return;
        }
        // Explicit offline check: exits before enrollment, recovery, startup
        // registration or any network/session work. No extra window is added.
        if (Array.Exists(e.Args, a => a.Equals("--video-preflight", StringComparison.OrdinalIgnoreCase)))
        {
            VideoPreflight.LogStartup();
            Shutdown();
            return;
        }
        try
        {
            if (await UnlockEnrollment.HandleSetupAsync(e.Args)) { Shutdown(); return; }
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Windows unlock setup", MessageBoxButton.OK, MessageBoxImage.Warning);
            Shutdown(1);
            return;
        }
        PeerInputPermission.SensitiveDesktop = () => UnlockOperation.Sensitive;
        PeerInputPermission.LockedDesktop = () =>
            ConnectLive.Unlock.WindowsSession.Locked(ConnectLive.Unlock.WindowsSession.CurrentId) == true;
        InputBlocker.LocalStopRequested += () => Dispatcher.BeginInvoke(new Action(DisableRemoteAccess));
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
            Log.Info("background startup declined: local startup permission is absent");
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
            Log.Warn("startup stopped: another Agent instance owns the process lock");
            if (!backgroundLaunch)
                MessageBox.Show("ConnectLive is already running. Run ConnectLive.exe /disable before starting another copy.",
                    "ConnectLive");
            Shutdown();
            return;
        }

        string? apiUrl = null;
        for (int i = 0; i < e.Args.Length; i++)
        {
            var a = e.Args[i];
            if (a == "--api-url" && i + 1 < e.Args.Length)
            {
                apiUrl = e.Args[++i];
            }
        }

        try
        {
            // Pairing is the only normal Agent UI; no status window or tray menu.
            var api = new ApiClient(apiUrl);
            Log.Info($"Agent gateway origin: {LocalGrant.OriginOf(api.ApiBaseUrl)}");
            if (apiUrl != null) ApiClient.SaveConfig(new ApiClient.AgentConfig(api.ApiBaseUrl));
            _api = api;
            api.LocalAuthorization = GrantStore.Load();
            if (InstallationLifecycle.RemovalRequested())
                throw new InvalidOperationException("This copy is being removed. Complete its removal before pairing or starting it.");
            var startWithWindows = Array.Exists(e.Args, a => a.Equals("--start-with-windows", StringComparison.OrdinalIgnoreCase));
            var forcePair = startWithWindows || Array.Exists(e.Args, a => a.Equals("--pair", StringComparison.OrdinalIgnoreCase));
            if (forcePair || !HasUsablePairing(api))
            {
                // Saved legacy credentials alone are NOT a pairing. Background
                // recovery cannot display a prompt or bypass local withdrawal.
                if (backgroundLaunch) { Shutdown(); return; }
                if (!await PairingPrompt.ShowAsync(api, _cts.Token, startWithWindows))
                {
                    DisableRemoteAccess();
                    return;
                }
            }
            if (_stopping || _cts.IsCancellationRequested) return;
            if (!HasUsablePairing(api))
                throw new InvalidOperationException("Pairing did not save matching device authorization. Remote access remains stopped.");
            // Later authentication failures must never open a new code window
            // or silently enroll another device.
            api.PairingProvider = null;
            api.OnLicenseChanged += OnLicenseChanged;
            var dispatcher = new WpfDispatcher(Current.Dispatcher);

            // A local opt-in, not enrollment alone, authorizes startup/recovery.
            try { StartupSelfHeal.EnsureAll(); } catch { }

            // Session bindings and /SESSION flags are not consent evidence.
            // Only fresh heartbeat authority and local acceptance can start work.
            ApiClient.ClearSessionBinding();
            if (_stopping || _cts.IsCancellationRequested) return;
            _agent = new Agent(api, Log.Info, dispatcher, onWake: null);
            _agent.SessionEndedRemotely += () =>
                Current.Dispatcher.BeginInvoke(new Action(RequestPairingAfterSessionEnd));
            _withdrawalTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _withdrawalTimer.Tick += (_, _) =>
            {
                if (LocalAccessState.IsDisabled() || InstallationLifecycle.RemovalRequested()) DisableRemoteAccess();
            };
            _withdrawalTimer.Start();
            _ = UnlockEnrollment.MonitorAsync(api, _cts.Token);

            // Heartbeat runs for the full application lifetime.
            await _agent.RunAsync(_cts.Token);
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested || _stopping)
        {
            // Local Disable/Close/Exit cancels enrollment and its retry delay.
        }
        catch (OperationCanceledException)
        {
            // Cancellation must not leave a half-enrolled background agent.
            DisableRemoteAccess();
        }
        catch (Exception ex)
        {
            try { _agent?.StopLocally(); } catch { }
            _cts.Cancel();
            Log.Warn($"startup: {ex.Message}");
            if (!backgroundLaunch)
                MessageBox.Show($"ConnectLive could not start. Remote access remains stopped.\n\n{ex.Message}",
                    "ConnectLive", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    private bool _pairingAfterSession;
    private async void RequestPairingAfterSessionEnd()
    {
        if (_pairingAfterSession || _stopping || _cts.IsCancellationRequested || _api == null) return;
        _pairingAfterSession = true;
        try
        {
            // This is a confirmed end of a previously accepted support visit,
            // never a proxy error, dropped video peer or failed heartbeat.
            if (!await PairingPrompt.ShowAsync(_api, _cts.Token, sessionEnded: true))
            {
                _agent?.StopLocally();
                _cts.Cancel();
                Shutdown();
                return;
            }
            if (!_stopping && !_cts.IsCancellationRequested && HasUsablePairing(_api))
                _agent?.ResumeAfterAuthorization();
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Log.Warn($"session-end pairing could not complete: {ex.GetType().Name}; remote access remains stopped");
            _agent?.StopLocally();
            _cts.Cancel();
            Shutdown(1);
        }
        finally { _pairingAfterSession = false; }
    }

    private static bool HasUsablePairing(ApiClient api) =>
        !LocalAccessState.IsDisabled() && !SessionPairingRequirement.Required && !InstallationLifecycle.RemovalRequested() &&
        !string.IsNullOrWhiteSpace(api.DeviceId) && !string.IsNullOrWhiteSpace(api.DeviceToken) &&
        api.LocalAuthorization is { Authorization: { } authorization } local &&
        local.DeviceId == api.DeviceId && local.Origin == LocalGrant.OriginOf(api.ApiBaseUrl) &&
        Guid.TryParse(authorization.Id, out _) && authorization.Capabilities is { View: true } &&
        authorization.Mode is ("attended" or "unattended");

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
            UnlockEnrollment.Forget();
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
    /// changes diagnostics, not the UI. The machine stays enrolled and keeps heartbeating, so it revives
    /// the instant a seat frees or the subscription renews.
    /// </summary>
    private void OnLicenseChanged(ApiClient.LicenseState lic)
    {
        Log.Warn($"license: {lic.State} ({lic.Reason ?? "-"})");
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
