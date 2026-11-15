using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

/// <summary>Explicit owner action; enabling startup is never implied by installing software.</summary>
internal static class StartupSetup
{
    internal static async Task<bool> HandleAsync(string[] args)
    {
        if (!Array.Exists(args, a => a.Equals("--startup-enable", StringComparison.OrdinalIgnoreCase))) return false;
        try
        {
            var exe = StartupRegistration.CurrentExePath();
            if (exe == null || !StartupRegistration.IsRunningFromInstallDir(exe, out var directory))
                throw new InvalidOperationException("Enable startup from the installed ConnectLive, not a downloaded or source-build copy.");
            if (!File.Exists(Path.Combine(directory!, "ConnectLiveWatch.exe")) ||
                !File.Exists(Path.Combine(directory!, "ConnectLiveUpdate.exe")))
                throw new InvalidOperationException("The installed companion apps are missing. Repair the installation first.");
            var grant = GrantStore.Load();
            if (grant == null || !grant.Authorization.Capabilities.View ||
                LocalAccessState.IsDisabled() || SessionPairingRequirement.RequiredOnDisk ||
                InstallationLifecycle.RemovalRequested())
                throw new InvalidOperationException("Open ConnectLive and complete an authorized pairing first. Startup cannot restore withdrawn access.");
            // A live technician must not approve persistence through remote
            // input. Reuse the existing cross-process owner-setup barrier.
            using var protection = new OwnerSetupProtection();
            await Task.Delay(1200);
            if (MessageBox.Show(
                "Enable startup after you sign in to this Windows account?\n\n" + StartupConsent.Notice,
                "ConnectLive — Windows startup", MessageBoxButton.YesNo, MessageBoxImage.Question,
                MessageBoxResult.No) != MessageBoxResult.Yes) return true;
            if (LocalAccessState.IsDisabled() || SessionPairingRequirement.RequiredOnDisk ||
                InstallationLifecycle.RemovalRequested() || grant != GrantStore.Load())
                throw new InvalidOperationException("Local authorization changed during setup. Startup was not enabled.");
            StartupConsent.Save(grant, true);
            var registered = StartupSelfHeal.EnsureAll();
            MessageBox.Show(registered
                ? "Windows startup and recovery are registered for this account. Verify them after a reboot and sign-in. Remote access still requires current server authorization."
                : "Your startup choice was saved, but Windows could not register all startup entries. Run Verify-Startup.ps1 and check the Agent log; startup is not fully verified.",
                "ConnectLive — Windows startup", MessageBoxButton.OK,
                registered ? MessageBoxImage.Information : MessageBoxImage.Warning);
        }
        catch (Exception ex)
        {
            Log.Warn($"startup setup failed: {ex.GetType().Name}");
            MessageBox.Show(ex.Message, "ConnectLive — Windows startup", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        return true;
    }
}
