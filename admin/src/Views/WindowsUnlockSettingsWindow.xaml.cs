using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using ConnectLive.Admin.Api;
using ConnectLive.Admin.Ui;

namespace ConnectLive.Admin.Views;

public partial class WindowsUnlockSettingsWindow : Window
{
    private readonly string _deviceId;
    private readonly CancellationTokenSource _stop = new();
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(10) };
    private WindowsUnlockDevice? _device;
    private bool _busy;
    public WindowsUnlockSettingsWindow(string deviceId, string name)
    {
        InitializeComponent(); AppIcon.Apply(this);
        _deviceId = deviceId; DeviceName.Text = name;
        Height = Math.Min(Height, SystemParameters.WorkArea.Height - 48);
        Loaded += async (_, _) => { await Refresh(); _poll.Start(); };
        _poll.Tick += async (_, _) => { if (!_busy) await Refresh(); };
        Closed += (_, _) => { _stop.Cancel(); _poll.Stop(); ClearPin(); };
        CommandManager.AddPreviewExecutedHandler(this, (_, e) =>
        {
            if (e.Command == ApplicationCommands.Copy || e.Command == ApplicationCommands.Cut) e.Handled = true;
        });
    }
    private void ClearPin() { Pin.Clear(); ConfirmPin.Clear(); Consent.IsChecked = false; }
    private void UpdateButtons()
    {
        bool manage = !_busy && !_stop.IsCancellationRequested && _device?.CanManage == true;
        Save.IsEnabled = manage && _device?.Enabled == true && _device.PublicKey != null;
        Forget.IsEnabled = manage && _device?.HasPin == true;
        Revoke.IsEnabled = manage && _device?.Enabled == true;
        Save.Content = _device?.HasPin == true ? "Replace PIN" : "Save PIN";
    }
    private async Task Refresh()
    {
        if (_busy || _stop.IsCancellationRequested) return;
        _busy = true; UpdateButtons();
        try
        {
            var value = await App.Api.GetWindowsUnlockAsync(_deviceId, _stop.Token);
            if (_stop.IsCancellationRequested) return;
            if (value.DeviceId != _deviceId) throw new InvalidOperationException("The response did not match the selected device.");
            if (_device != null && (_device.KeyId != value.KeyId || _device.AuthorizationId != value.AuthorizationId)) ClearPin();
            _device = value;
            Status.Text = $"Permission: {(value.Enabled ? "locally authorized" : "not authorized")}\n" +
                $"Windows account: {value.WindowsAccount ?? "unknown"}\n" +
                $"Helper: {(value.HelperReady ? "ready" : "unavailable or offline")}\n" +
                $"Saved PIN: {(value.HasPin ? "saved — cannot be shown" : "none")}\n" +
                $"Windows: {(value.Locked == true ? "locked" : value.Locked == false ? "unlocked" : "unknown")}" +
                (value.CanManage ? "" : "\nYour role cannot change the saved PIN or permission.");
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (Exception ex) { _device = null; Status.Text = ex.Message; }
        finally { _busy = false; UpdateButtons(); }
    }
    private async Task Mutate(Func<Task<WindowsUnlockDevice>> operation, string message)
    {
        if (_busy || _stop.IsCancellationRequested) return;
        _busy = true; UpdateButtons(); Result.Text = "";
        try
        {
            var result = await operation();
            if (!_stop.IsCancellationRequested && result.DeviceId == _deviceId) Result.Text = message;
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (Exception ex) { if (!_stop.IsCancellationRequested) Result.Text = ex.Message; }
        finally { ClearPin(); _busy = false; await Refresh(); }
    }
    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        var device = _device;
        if (device == null || !device.CanManage || !device.Enabled || Consent.IsChecked != true ||
            Pin.Password.Length is < 4 or > 127 || Pin.Password != ConfirmPin.Password)
        { Result.Text = "Read the disclosure, accept it, and enter the same PIN twice."; return; }
        string value = Pin.Password;
        ClearPin();
        await Mutate(() => App.Api.SaveWindowsPinAsync(device, value, _stop.Token), "Encrypted PIN saved for this Agent. It cannot be shown again.");
    }
    private async void Forget_Click(object sender, RoutedEventArgs e)
    {
        if (MessageBox.Show(this, "Remove the saved PIN from active use? Lock-screen permission stays enabled.",
            "Forget saved PIN", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        await Mutate(() => App.Api.RemoveWindowsPinAsync(_deviceId, false, _stop.Token), "Saved PIN removed from active use.");
    }
    private async void Revoke_Click(object sender, RoutedEventArgs e)
    {
        if (MessageBox.Show(this, "Revoke Windows lock-screen access and remove its saved PIN? An offline Agent clears its encryption identity after reconnecting; backups follow normal retention.",
            "Revoke lock-screen access", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        await Mutate(() => App.Api.RemoveWindowsPinAsync(_deviceId, true, _stop.Token), "Windows unlock permission revoked.");
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await Refresh();
    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
