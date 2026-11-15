using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace ConnectLive.Agent;

internal static class OwnerPinSetup
{
    internal static async Task ShowAsync(ApiClient api)
    {
        // Establish cross-process protection BEFORE making a PIN field.
        using var protection = new OwnerSetupProtection();
        await Task.Delay(1200); // ordinary Agent observes the pause and disposes microphone.
        var panel = new StackPanel { Margin = new Thickness(20) };
        var window = new Window { Title = "Optional Windows Hello PIN setup", Width = 540,
            SizeToContent = SizeToContent.Height, Content = panel, WindowStartupLocation = WindowStartupLocation.CenterScreen };
        panel.Children.Add(new TextBlock { Text =
            "Optional: save an owner-supplied Windows Hello PIN for this device's lock screen. " +
            "It does not approve browser autofill, saved-password or passkey prompts. " +
            "Saving a reusable PIN reduces the protection of a device-only PIN. Skip keeps ordinary support working.",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0,0,0,12) });
        var status = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0,0,0,12) };
        panel.Children.Add(status);
        var setup = new Button { Content = "Export trusted-helper setup", Margin = new Thickness(0,3,0,3) };
        var enable = new Button { Content = "Approve encryption enrollment / replace key", Margin = new Thickness(0,3,0,3) };
        panel.Children.Add(setup); panel.Children.Add(enable);
        var pin = new PasswordBox { MaxLength = 127, Margin = new Thickness(0,8,0,3), IsEnabled = false };
        var confirm = new PasswordBox { MaxLength = 127, Margin = new Thickness(0,3,0,8), IsEnabled = false };
        foreach (var field in new[] { pin, confirm })
        {
            field.CommandBindings.Add(new CommandBinding(ApplicationCommands.Copy, (_, e) => e.Handled = true));
            field.CommandBindings.Add(new CommandBinding(ApplicationCommands.Cut, (_, e) => e.Handled = true));
            field.CommandBindings.Add(new CommandBinding(ApplicationCommands.Paste, (_, e) => e.Handled = true));
        }
        panel.Children.Add(new TextBlock { Text = "Windows Hello PIN (entered by you, never read from Windows)" });
        panel.Children.Add(pin); panel.Children.Add(new TextBlock { Text = "Confirm PIN" }); panel.Children.Add(confirm);
        var consent = new CheckBox { Content = "I authorize this device-bound encrypted, reusable PIN.", Margin = new Thickness(0,5,0,5) };
        var save = new Button { Content = "Save encrypted PIN", IsEnabled = false, Margin = new Thickness(0,5,0,5) };
        var skip = new Button { Content = "Skip / close", Margin = new Thickness(0,5,0,5) };
        panel.Children.Add(consent); panel.Children.Add(save); panel.Children.Add(skip);
        var done = new TaskCompletionSource();
        bool busy = false, closed = false;
        async Task Refresh()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var readiness = await UnlockEnrollment.SetupStatusAsync(api, timeout.Token);
            if (closed) return;
            status.Text = $"Local approval: {readiness.localApproval}\nTrusted helper installation: {readiness.helperInstallation}\n" +
                $"Current protected Agent identity: {readiness.protectedIdentity}\nEncryption enrollment: {readiness.encryptionEnrollment}\n" +
                $"Saved credential: {readiness.savedCredential} (not Windows-validated)\n" +
                $"Lock-screen scenario: {readiness.lockScreen}\nBrowser verification: approve on device\nConnectivity: {readiness.connectivity}";
            bool ready = readiness.localApproval == "ready" && readiness.helperInstallation == "ready" &&
                readiness.protectedIdentity == "ready" && readiness.encryptionEnrollment == "ready" && readiness.connectivity == "ready";
            pin.IsEnabled = confirm.IsEnabled = save.IsEnabled = ready;
        }
        async Task Run(string argument)
        {
            if (busy) return; busy = true;
            try { await UnlockEnrollment.HandleSetupAsync(new[] { argument }); await Refresh(); }
            catch { status.Text = "Trusted setup was not confirmed. Source-run or writable installations cannot install privileged support. Follow docs/windows-unlock.md; no elevation was attempted."; }
            finally { busy = false; }
        }
        setup.Click += async (_, _) => await Run("--unlock-setup");
        enable.Click += async (_, _) => await Run("--unlock-enable");
        save.Click += async (_, _) => {
            if (busy || consent.IsChecked != true) { status.Text = "Approve the reusable credential disclosure first."; return; }
            busy = true; save.IsEnabled = false;
            byte[]? bytes = null, other = null;
            try
            {
                bytes = ReadPin(pin); other = ReadPin(confirm);
                pin.Clear(); confirm.Clear(); consent.IsChecked = false;
                if (!CryptographicOperations.FixedTimeEquals(bytes, other)) throw new InvalidOperationException();
                await UnlockEnrollment.SaveOwnerPinAsync(api, bytes);
                if (!closed) status.Text = "Encrypted PIN saved for this enrolled device. It has not been validated by Windows. Browser verification still requires on-device approval.";
            }
            catch { if (!closed) status.Text = "PIN save was not confirmed. Check matching entries, trusted-helper readiness, connectivity and the separately approved schema update. No automatic retry was made."; }
            finally
            {
                if (bytes != null) CryptographicOperations.ZeroMemory(bytes);
                if (other != null) CryptographicOperations.ZeroMemory(other);
                busy = false; pin.Clear(); confirm.Clear(); if (!closed) save.IsEnabled = true;
            }
        };
        skip.Click += (_, _) => window.Close();
        window.Closed += (_, _) => { closed = true; pin.Clear(); confirm.Clear(); done.TrySetResult(); };
        window.Show(); await Refresh(); await done.Task;
    }
    private static byte[] ReadPin(PasswordBox field)
    {
        using var secret = field.SecurePassword;
        if (secret.Length is < 4 or > 127) throw new InvalidOperationException();
        IntPtr pointer = Marshal.SecureStringToGlobalAllocUnicode(secret);
        var result = new byte[secret.Length];
        try
        {
            for (int i = 0; i < result.Length; i++)
            {
                int ch = Marshal.ReadInt16(pointer, i * 2);
                if (ch is < 32 or > 126) throw new InvalidOperationException();
                result[i] = (byte)ch;
            }
            return result;
        }
        catch { CryptographicOperations.ZeroMemory(result); throw; }
        finally { Marshal.ZeroFreeGlobalAllocUnicode(pointer); }
    }
}
