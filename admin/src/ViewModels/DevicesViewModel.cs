using System;
using System.Collections.ObjectModel;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ConnectLive.Admin.Api;
using ConnectLive.Admin.Views;

namespace ConnectLive.Admin.ViewModels;

public partial class DeviceItem : ObservableObject
{
    public string RowId { get; init; } = "";
    public string DeviceId { get; init; } = "";
    [ObservableProperty] private string displayName = "";
    [ObservableProperty] private string hostname = "";
    [ObservableProperty] private string os = "";
    [ObservableProperty] private string status = "offline";
    [ObservableProperty] private string lastSeen = "never";
    [ObservableProperty] private bool inSession;
}

public partial class DevicesViewModel : ObservableObject
{
    public ObservableCollection<DeviceItem> Devices { get; } = new();

    [ObservableProperty] private bool busy;
    [ObservableProperty] private string? error;

    private CancellationTokenSource? _pollCts;

    public void StartPolling()
    {
        _pollCts?.Cancel();
        _pollCts = new CancellationTokenSource();
        _ = Task.Run(() => PollLoop(_pollCts.Token));
    }

    public void StopPolling()
    {
        _pollCts?.Cancel();
        _pollCts = null;
    }

    // Exponential back-off (seconds) on consecutive Refresh() failures.
    // Mirrors the watcher's cadence so a flaky link doesn't hammer the gateway.
    private static readonly int[] BackoffSeconds = { 5, 10, 20, 30 };

    private async Task PollLoop(CancellationToken ct)
    {
        int step = 0;
        int consecutiveFailures = 0;
        while (!ct.IsCancellationRequested)
        {
            bool ok = false;
            try
            {
                // Refresh returns false when a previous pass is still in
                // flight — that is NOT a healthy poll, so we must not reset
                // the back-off (a wedged request used to look like success
                // while the grid quietly went stale).
                ok = await Refresh().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                consecutiveFailures++;
                if (consecutiveFailures >= 2)
                    Application.Current?.Dispatcher.Invoke(() => Error = ex.Message);
            }

            if (ok) { step = 0; consecutiveFailures = 0; }
            else if (step < BackoffSeconds.Length - 1) step++;

            try { await Task.Delay(TimeSpan.FromSeconds(BackoffSeconds[step]), ct).ConfigureAwait(false); } catch { return; }
        }
    }


    // Command entry point (AsyncRelayCommand needs a plain Task).
    [RelayCommand]
    public Task Refresh() => RefreshOnceAsync();

    /// <summary>Returns false when the pass was skipped or nothing ran.</summary>
    public async Task<bool> RefreshOnceAsync()
    {
        if (Busy) return false;
        SetBusy(true);
        try
        {
            var list = await App.Api.ListDevicesAsync(CancellationToken.None).ConfigureAwait(false);
            Application.Current?.Dispatcher.Invoke(() =>
            {
                Devices.Clear();
                foreach (var d in list)
                {
                    var age = d.LastSeenAt.HasValue
                        ? (DateTime.UtcNow - d.LastSeenAt.Value.UtcDateTime).TotalSeconds
                        : double.MaxValue;
                    var isOnline = age < 30;
                    Devices.Add(new DeviceItem
                    {
                        RowId = d.Id,
                        DeviceId = d.DeviceId,
                        DisplayName = d.DisplayName ?? d.Hostname ?? d.DeviceId,
                        Hostname = d.Hostname ?? "",
                        Os = d.Os ?? "",
                        Status = isOnline ? "online" : "offline",
                        LastSeen = FormatAge(age),
                        InSession = d.IsSessionActive,
                    });
                }
                Error = null;
            });
            return true;
        }
        finally { SetBusy(false); }
    }

    // Busy drives command CanExecute, so it must only ever change on the UI
    // thread — the poll loop runs on a worker.
    private void SetBusy(bool value)
    {
        var d = Application.Current?.Dispatcher;
        if (d == null || d.CheckAccess()) Busy = value;
        else d.Invoke(() => Busy = value);
    }


    private static string FormatAge(double sec)
    {
        if (sec == double.MaxValue) return "never";
        if (sec < 60) return $"{(int)sec}s ago";
        if (sec < 3600) return $"{(int)(sec / 60)}m ago";
        if (sec < 86400) return $"{(int)(sec / 3600)}h ago";
        return $"{(int)(sec / 86400)}d ago";
    }

    [RelayCommand]
    public async Task Connect(DeviceItem? item)
    {
        if (item == null) return;
        try
        {
            var session = await App.Api.CreateSessionAsync(item.RowId, "view", CancellationToken.None);
            var win = new LiveSessionWindow(session.Id, item);
            win.Show();
        }
        catch (SupabaseCallException ex)
        {
            MessageBox.Show(ex.Message, "ConnectLive Admin — session failed",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "ConnectLive Admin — session failed",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    [RelayCommand]
    public async Task Delete(DeviceItem? item)
    {
        if (item == null) return;
        if (MessageBox.Show($"Delete device \"{item.DisplayName}\"? This cannot be undone.",
            "Delete device", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
            return;
        try
        {
            await App.Api.DeleteDeviceAsync(item.RowId, CancellationToken.None);
            Devices.Remove(item);
        }
        catch (SupabaseCallException ex)
        {
            MessageBox.Show(ex.Message, "ConnectLive Admin — delete failed",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}
