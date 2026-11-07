using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ConnectLive.Admin.Input;
using ConnectLive.Admin.Views;

namespace ConnectLive.Admin.ViewModels;

public partial class LiveSessionViewModel
{
    [ObservableProperty] private bool unlockActive;
    [ObservableProperty] private bool unlockReady;
    [ObservableProperty] private string unlockStatus = "Windows sign-in requires separate local setup and permission.";
    private bool _unlockPreparing;
    private bool _securePixelsSeen;
    private WindowsUnlockChannel? _unlockChannel;
    public bool UnlockIdle => !UnlockActive && !_unlockPreparing;
    partial void OnUnlockActiveChanged(bool value)
    {
        OnPropertyChanged(nameof(UnlockIdle)); OnPropertyChanged(nameof(InputAuthoritative));
    }
    partial void OnUnlockReadyChanged(bool value) => OnPropertyChanged(nameof(InputAuthoritative));
    private void OnUnlockChanged(string session, WindowsUnlockState state)
    {
        if (session != SessionId) return;
        Application.Current?.Dispatcher.InvokeAsync(() =>
        {
            if (_cts?.IsCancellationRequested != false || _stopped != 0) return;
            UnlockActive = state.Phase is "starting" or "ready" or "submitted";
            if (UnlockActive) _securePixelsSeen = true;
            UnlockReady = state.Phase == "ready";
            Mode = "view"; CurtainOn = false; StopCurtainHeartbeat();
            UnlockStatus = state.Phase switch {
                "ready" => "Secure Windows sign-in ready. Click the remote PIN field; type manually or explicitly use the saved PIN.",
                "submitted" => "PIN submitted once. Waiting for Windows; no retry.",
                "unlocked" => "Last attempt: Windows reported unlocked. Returned to view-only; control and curtain are not re-enabled.",
                "starting" => "Preparing the secure sign-in screen…",
                "cancelled" => "Unlock cancelled. Back to view-only.",
                _ => "Unlock blocked. " + (state.Reason ?? "Check the connection and local setup."),
            };
        });
    }
    [RelayCommand]
    private void WindowsUnlockSettings()
    {
        new WindowsUnlockSettingsWindow(Device.RowId, Device.DisplayName) {
            Owner = Application.Current?.MainWindow,
        }.ShowDialog();
    }
    [RelayCommand]
    private async Task UnlockWindows()
    {
        if (!UnlockIdle || TakenOver || _cts?.IsCancellationRequested != false) return;
        var channel = InputTransport.Unlock;
        if (channel == null || channel.SessionId != SessionId || !channel.Ready || _rtc == null)
        { UnlockStatus = "Connect a live command channel before unlocking Windows."; return; }
        _unlockPreparing = true; _securePixelsSeen = true;
        InputTransport.BlockOrdinaryInput(SessionId);
        Mode = "view"; CurtainOn = false; StopCurtainHeartbeat();
        OnPropertyChanged(nameof(UnlockIdle)); OnPropertyChanged(nameof(InputAuthoritative));
        var token = _cts.Token;
        try
        {
            var status = await App.Api.GetWindowsUnlockAsync(Device.RowId, token);
            if (!status.Enabled || !status.HelperReady || status.Locked != true || status.AuthorizationId == null)
                throw new InvalidOperationException("A current locked state and the locally approved unlock service are required.");
            // Stop recording and ordinary control before the first secure frame.
            Interlocked.Increment(ref _recordingGeneration);
            Interlocked.Exchange(ref _recordingAllowedUntil, 0);
            if (_rtc.IsRecording)
            {
                var path = _rtc.StopRecording();
                FilesStatus = path == null ? "Recording stopped." : $"Recording saved to {path}";
            }
            if (_rtc.IsRecording) throw new InvalidOperationException("Recording has not stopped; unlock is blocked.");
            IsRecording = false; RecordLabel = "Record"; FilesPanelOpen = false;
            StopCurtainHeartbeat(); CurtainOn = false; Mode = "view";
            await App.Api.SetSessionModeAsync(SessionId, "view", token);
            var ticket = await App.Api.BeginWindowsUnlockAsync(Device.RowId, SessionId, channel.PeerId, token);
            if (token.IsCancellationRequested || TakenOver || InputTransport.Unlock != channel || !channel.Ready)
                throw new InvalidOperationException("The live session changed. No unlock input was sent.");
            _unlockChannel = channel;
            channel.Begin(ticket, status.AuthorizationId);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception ex) { UnlockStatus = ex.Message; }
        finally { _unlockPreparing = false; OnPropertyChanged(nameof(UnlockIdle)); OnPropertyChanged(nameof(InputAuthoritative)); }
    }
    [RelayCommand]
    private void UseSavedWindowsPin()
    {
        if (!UnlockReady || _unlockChannel != InputTransport.Unlock) return;
        if (MessageBox.Show("Confirm the correct Windows account and an empty Windows Hello PIN field are selected on the visible sign-in screen. Submit the saved PIN once, with no retry?",
            "Use saved Windows Hello PIN", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        try { _unlockChannel?.UseSavedPin(); }
        catch (Exception ex) { UnlockStatus = ex.Message; }
    }
    [RelayCommand] private void CancelWindowsUnlock() => _unlockChannel?.Cancel();
    [RelayCommand] private void WindowsSecureAttention()
    {
        if (_unlockChannel?.SecureAttention() != true) UnlockStatus = "Secure attention was not requested.";
    }
}
