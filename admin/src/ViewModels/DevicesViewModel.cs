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
    // WoL routing hints copied from devices.metadata (subnet + MAC). Populated
    // by the agent's heartbeat; used by the staged Wake command below.
    public string? LanSubnetV4 { get; init; }
    public string? Mac { get; init; }
    public bool IsOffline => Status != "online";
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
    // Mirrors the updater's cadence so a flaky link doesn't hammer the gateway.
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
                ok = await RefreshOnceAsync().ConfigureAwait(false);
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
                    string? subnet = null;
                    string? mac = null;
                    try
                    {
                        if (d.Metadata.ValueKind == System.Text.Json.JsonValueKind.Object)
                        {
                            if (d.Metadata.TryGetProperty("lan_subnet_v4", out var s) && s.ValueKind == System.Text.Json.JsonValueKind.String)
                                subnet = s.GetString();
                            if (d.Metadata.TryGetProperty("mac", out var m) && m.ValueKind == System.Text.Json.JsonValueKind.String)
                                mac = m.GetString();
                        }
                    }
                    catch { /* metadata is best-effort */ }
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
                        LanSubnetV4 = subnet,
                        Mac = mac,
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
            // Explicit wake: covers the case where the user manually closed the
            // agent tray icon. Updater heartbeat picks this up and relaunches.
            try
            {
                await App.Api.EnqueuePowerCommandAsync(
                    item.RowId, "wake_agent",
                    new { session_id = session.Id },
                    CancellationToken.None);
            }
            catch { /* best-effort; session state flip is the primary signal */ }
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

    // Staged Wake-on-LAN command that mirrors the web console's failure
    // reporting: we surface *why* a wake can or can't route before we ever
    // touch power_commands, so the operator never gets a silent no-op.
    //   Stage 1: already online — nothing to wake, just Connect.
    //   Stage 2: no LAN subnet on file — device hasn't heartbeat'd yet.
    //   Stage 3: no MAC on file — WoL needs both subnet + MAC.
    //   Stage 4: no online peer on the same subnet to broadcast the packet.
    // Only when all four gates pass do we enqueue the WoL power command.
    [RelayCommand]
    public async Task Wake(DeviceItem? item)
    {
        if (item == null) return;
        if (!item.IsOffline)
        {
            MessageBox.Show($"{item.DisplayName} is already online — use Connect instead.",
                "Wake", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (string.IsNullOrEmpty(item.LanSubnetV4))
        {
            MessageBox.Show(
                $"{item.DisplayName} has never reported a LAN subnet, so Wake-on-LAN can't be routed. It must check in once while online first.",
                "Wake unavailable", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        if (string.IsNullOrEmpty(item.Mac))
        {
            MessageBox.Show(
                $"Subnet {item.LanSubnetV4} is known but no MAC address has been recorded yet — WoL needs both. Let the agent check in once more while online.",
                "Wake unavailable", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        DeviceItem? peer = null;
        foreach (var p in Devices)
        {
            if (p.RowId == item.RowId) continue;
            if (p.IsOffline) continue;
            if (!string.Equals(p.LanSubnetV4, item.LanSubnetV4, StringComparison.Ordinal)) continue;
            peer = p; break;
        }
        if (peer == null)
        {
            MessageBox.Show(
                $"Powered-off wake needs another ConnectLive machine online on {item.LanSubnetV4} to broadcast the magic packet. None is online right now.",
                "No relay peer", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        try
        {
            await App.Api.EnqueuePowerCommandAsync(
                item.RowId, "wake",
                new { mac = item.Mac },
                peer.RowId,
                CancellationToken.None);
            MessageBox.Show(
                $"Wake queued for {item.DisplayName} via {peer.DisplayName}.",
                "Wake", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (SupabaseCallException ex)
        {
            MessageBox.Show(ex.Message, "Wake failed", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}
