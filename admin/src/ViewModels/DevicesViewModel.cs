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

    private async Task PollLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Refresh(); }
            catch (Exception ex) { Application.Current?.Dispatcher.Invoke(() => Error = ex.Message); }
            try { await Task.Delay(5000, ct); } catch { }
        }
    }

    [RelayCommand]
    public async Task Refresh()
    {
        if (Busy) return;
        Busy = true;
        try
        {
            var list = await App.Api.ListDevicesAsync(CancellationToken.None);
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
        }
        finally { Busy = false; }
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
        var session = await App.Api.CreateSessionAsync(item.RowId, "view", CancellationToken.None);
        if (session == null)
        {
            MessageBox.Show("Failed to start session.", "ConnectLive Admin");
            return;
        }
        var win = new LiveSessionWindow(session.Id, item);
        win.Show();
    }

    [RelayCommand]
    public async Task Delete(DeviceItem? item)
    {
        if (item == null) return;
        if (MessageBox.Show($"Delete device \"{item.DisplayName}\"? This cannot be undone.",
            "Delete device", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
            return;
        if (await App.Api.DeleteDeviceAsync(item.RowId, CancellationToken.None))
            Devices.Remove(item);
    }
}
