using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Agent;

internal sealed class SessionToolsConnection : IDisposable
{
    private readonly ApiClient _api;
    private readonly RTCDataChannel _channel;
    private readonly ToolBinding _binding;
    private readonly PeerInputPermission _owner;
    private readonly Func<bool> _connected;
    private readonly Func<bool> _audioReady;
    private readonly Action<byte[]> _audio;
    private readonly Func<VerifiedFileChannel?> _files;
    private readonly Action _viewOnly;
    private readonly CancellationTokenSource _stop;
    private readonly RemoteFileAccess _browser = new();
    private readonly MicrophoneLease _micLease = new(() => Environment.TickCount64);
    private readonly HashSet<string> _used = new();
    private readonly ConcurrentDictionary<string, byte> _cancelled = new();
    private readonly Timer _watch;
    private WindowsMicrophone? _microphone;
    private MicrophoneIndicator? _indicator;
    private string? _micId, _verificationId, _downloadId;
    private long _sequence, _verificationStart, _verificationRenew;
    private int _busy, _renewing, _disposed;
    private CancellationTokenSource? _download;
    private bool Current => _disposed == 0 && !_stop.IsCancellationRequested && _connected() && _owner.Allows("view") &&
        !LocalAccessState.IsDisabled() && _api.LocalAuthorization?.Authorization.Id == _binding.authorizationId;
    private bool Ordinary => Current && !UnlockOperation.Sensitive && !AppVerification.Active && !OwnerSetupProtection.Active;
    private bool MicAllowed(string id) => _micLease.Allowed(id,
        SessionToolsPolicy.Read(_api)?.Microphone == true, Ordinary && _audioReady() &&
        ConnectLive.Unlock.WindowsSession.Locked(ConnectLive.Unlock.WindowsSession.CurrentId) == false);
    internal SessionToolsConnection(ApiClient api, RTCDataChannel channel, ToolBinding binding, PeerInputPermission owner,
        Func<bool> connected, Func<bool> audioReady, Action<byte[]> audio, Func<VerifiedFileChannel?> files, Action viewOnly)
    {
        _api = api; _channel = channel; _binding = binding; _owner = owner;
        _connected = connected; _audioReady = audioReady; _audio = audio; _files = files; _viewOnly = viewOnly;
        _stop = CancellationTokenSource.CreateLinkedTokenSource(owner.Token);
        Log.Info("session_tools protocol=1 files=2 microphone=opt_in app_verification=on_device_only");
        channel.onmessage += (sender, protocol, data) => {
            if (protocol != DataChannelPayloadProtocols.WebRTC_String || data.Length > 8192 || !Current) return;
            try
            {
                using var doc = JsonDocument.Parse(data);
                var root = doc.RootElement;
                if (!binding.Matches(root) || !Guid.TryParse(root.GetProperty("requestId").GetString(), out _) ||
                    !root.GetProperty("sequence").TryGetInt64(out var sequence) || sequence <= Interlocked.Read(ref _sequence)) return;
                Interlocked.Exchange(ref _sequence, sequence);
                string id = root.GetProperty("requestId").GetString()!, action = root.GetProperty("action").GetString()!;
                if (action == "microphone_off") { StopMicrophone("off", id); return; }
                if (action == "microphone_renew") { if (_micLease.RenewBrowser(id)) _ = RenewMic(id); return; }
                if (action == "verification_renew") { if (id == _verificationId) _verificationRenew = Environment.TickCount64; return; }
                if (action is "verification_cancel" or "verification_finish")
                {
                    if (_cancelled.Count >= 512) { Dispose(); return; }
                    _cancelled.TryAdd("v:"+id,0);
                    if (id == _verificationId) EndVerification(action == "verification_cancel" ? "cancelled" : "result_unconfirmed");
                    return;
                }
                if (action == "download_cancel")
                {
                    var transferId=root.GetProperty("payload").GetProperty("transferId").GetString();
                    if (!Guid.TryParse(transferId,out _)) return;
                    if (_cancelled.Count >= 512) { Dispose(); return; }
                    _cancelled.TryAdd("d:"+transferId,0);
                    if (_downloadId == transferId) _download?.Cancel();
                    return;
                }
                if (_used.Count >= 512 || !_used.Add(id)) { Reply(action, id, false, null, "request_already_used"); return; }
                if (Interlocked.Exchange(ref _busy, 1) != 0) { Reply(action, id, false, null, "tool_busy"); return; }
                var payload = root.GetProperty("payload").Clone();
                _ = Handle(action, id, payload);
            }
            catch { /* No raw payloads or exception text enter logs. */ }
        };
        channel.onclose += Dispose;
        _watch = new Timer(_ => {
            if (!Current) { Dispose(); return; }
            if (_micId is { } mic && !MicAllowed(mic)) StopMicrophone("transport_failure");
            if (_verificationId != null && (Environment.TickCount64 - _verificationStart > 120_000 ||
                Environment.TickCount64 - _verificationRenew > 5000 || UnlockOperation.Sensitive))
                EndVerification("cancelled");
            if (!Ordinary) _download?.Cancel();
        }, null, 200, 200);
    }
    private void Reply(string action, string id, bool ok, object? value, string? error = null)
    {
        if (!Current || _channel.readyState != RTCDataChannelState.open) return;
        try { _channel.send(JsonSerializer.Serialize(new { version = 1, binding = _binding, requestId = id, action, ok, value, error })); }
        catch { }
    }
    private async Task Handle(string action, string id, JsonElement payload)
    {
        var microphoneGeneration = _micLease.Generation;
        try
        {
            var scope = action is "list" or "download" ? "files" : action == "microphone_on" ? "microphone" :
                action == "verification_begin" ? "verification" : "status";
            if (!Current || !await _api.ConfirmToolAuthorityAsync(_binding, scope, _stop.Token) || !Current)
                throw new IOException("permission_or_connectivity_unavailable");
            if (action == "status")
            {
                var consent = SessionToolsPolicy.Read(_api);
                using var statusBudget = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                statusBudget.CancelAfter(TimeSpan.FromSeconds(1));
                // Helper/network diagnostics must not block ordinary file and
                // microphone capability negotiation. Unknown remains unknown.
                var setup = await UnlockEnrollment.SetupStatusAsync(_api, statusBudget.Token);
                Reply("status", id, true, new {
                    roots = _owner.Allows("files") ? consent?.Folders.Select(r => new { id = r.Id, name = r.Name }).ToArray() ?? [] : [],
                    microphoneAllowed = consent?.Microphone == true,
                    setup,
                });
            }
            else if (action == "list")
            {
                var root = Root(payload.GetProperty("rootId").GetString()!);
                var path = payload.GetProperty("path").GetString()!;
                var cursor = payload.TryGetProperty("cursor", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
                var page = _browser.List(root, path, cursor, () => Ordinary && _owner.Allows("files") && RootStillApproved(root));
                if (!await _api.ConfirmToolAuthorityAsync(_binding,"files",_stop.Token) ||
                    !Ordinary || !RootStillApproved(root)) throw new IOException("authorization_changed");
                Reply("list", id, true, page);
            }
            else if (action == "download")
            {
                if (_download != null || !Ordinary || !_owner.Allows("files")) throw new IOException("file_unavailable_or_busy");
                var root = Root(payload.GetProperty("rootId").GetString()!);
                var path = payload.GetProperty("path").GetString()!;
                var transferId = payload.GetProperty("transferId").GetString()!;
                if (!Guid.TryParseExact(transferId, "D", out _)) throw new IOException("invalid_transfer_id");
                if (_cancelled.ContainsKey("d:"+transferId)) throw new IOException("file_cancelled");
                var read = RemoteFileAccess.Open(root, path, payload.GetProperty("revision").GetString()!, payload.GetProperty("size").GetInt64());
                var fileChannel = _files();
                if (fileChannel == null) { read.Dispose(); throw new IOException("verified_file_channel_required"); }
                var cancellation = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                _download = cancellation; _downloadId = transferId;
                if (_cancelled.ContainsKey("d:"+transferId)) cancellation.Cancel();
                Reply("download", id, true, new { transferId, state = "accepted" });
                _ = Download(read, root, fileChannel, transferId, Path.GetFileName(path), cancellation);
            }
            else if (action == "microphone_on")
            {
                if (!Ordinary || SessionToolsPolicy.Read(_api)?.Microphone != true)
                { Reply("microphone", id, true, new { phase = "permission_denied" }); return; }
                if (!_audioReady()) { Reply("microphone", id, true, new { phase = "transport_failure" }); return; }
                if (!_micLease.Start(id, true, Ordinary, microphoneGeneration)) throw new IOException("microphone_request_cancelled_or_used");
                _micId = id;
                try
                {
                    // Visibility/physical stop is a prerequisite, not an afterthought.
                    _indicator = new MicrophoneIndicator(() => StopMicrophone("locally_stopped"));
                    if (!MicAllowed(id)) throw new IOException("transport_failure");
                    _microphone = new WindowsMicrophone(() => MicAllowed(id), _audio,
                        reason => StopMicrophone(reason));
                    if (!MicAllowed(id)) { StopMicrophone("transport_failure"); return; }
                    Reply("microphone", id, true, new { phase = "sharing" });
                }
                catch (Exception ex)
                {
                    StopMicrophone(ex.Message == "permission_denied" ? "permission_denied" : "device_unavailable");
                }
            }
            else if (action == "verification_begin")
            {
                if (_cancelled.ContainsKey("v:"+id)) throw new IOException("verification_cancelled");
                if (!Ordinary || CurtainController.ActiveFor(_owner))
                    throw new IOException("release_curtain_explicitly_before_on_device_approval");
                string scenario = payload.GetProperty("scenario").GetString()!;
                if (scenario is not ("autofill" or "saved_passwords" or "passkey")) throw new IOException("unsupported_scenario");
                StopMicrophone("off");
                _download?.Cancel();
                _viewOnly(); // Neither completion nor cancellation resumes control.
                if (!AppVerification.Begin(this)) throw new IOException("verification_busy");
                _verificationId = id; _verificationStart = _verificationRenew = Environment.TickCount64;
                if (_cancelled.ContainsKey("v:"+id)) { EndVerification("cancelled"); return; }
                Reply("verification", id, true, new { phase = "approval_required", reason = "on_device_only_no_pin_released" });
                Log.Info($"verification request={id} phase=approval_required scenario={scenario} credential_released=false");
            }
            else throw new IOException("unsupported_tool_action");
        }
        catch (Exception ex)
        {
            var reason = ex is UnauthorizedAccessException ? "permission_denied" :
                ex is FileNotFoundException or DirectoryNotFoundException ? "file_or_folder_not_found" :
                ex is IOException && System.Text.RegularExpressions.Regex.IsMatch(ex.Message, "^[a-z_]{1,80}$") ? ex.Message :
                "tool_unavailable";
            Reply(action, id, false, null, reason);
            Log.Warn($"session_tool request={id} action={(action is "list" or "download" or "status" or "verification_begin" or "microphone_on" ? action : "unknown")} result={reason}");
        }
        finally { Interlocked.Exchange(ref _busy, 0); }
    }
    private ApprovedFolder Root(string id)
    {
        if (!Ordinary || !_owner.Allows("files")) throw new IOException("permission_denied");
        return SessionToolsPolicy.Read(_api)?.Folders.FirstOrDefault(r => r.Id == id) ?? throw new IOException("folder_not_approved");
    }
    private bool RootStillApproved(ApprovedFolder root) =>
        SessionToolsPolicy.Read(_api)?.Folders.Contains(root) == true;
    private async Task Download(RemoteFileAccess.ApprovedRead read, ApprovedFolder root, VerifiedFileChannel channel,
        string id, string name, CancellationTokenSource stop)
    {
        using (read)
        using (stop)
        using (var watch = new Timer(_ => { if (!Ordinary || !_owner.Allows("files") || !RootStillApproved(root)) stop.Cancel(); },
            null, 100, 100))
        {
            try { await channel.SendFile(read, id, name, stop.Token); }
            catch { channel.Fail(id, "file_changed_cancelled_or_unconfirmed"); }
            finally { if (ReferenceEquals(_download, stop)) { _download = null; _downloadId = null; } }
        }
    }
    private async Task RenewMic(string id)
    {
        if (Interlocked.Exchange(ref _renewing, 1) != 0) return;
        try
        {
            if (!MicAllowed(id) || !await _api.ConfirmToolAuthorityAsync(_binding, "microphone", _stop.Token) || !MicAllowed(id))
            { StopMicrophone("transport_failure"); return; }
            _micLease.Authority(id);
            Reply("microphone", id, true, new { phase = "sharing" });
        }
        catch { StopMicrophone("transport_failure"); }
        finally { Interlocked.Exchange(ref _renewing, 0); }
    }
    internal void StopMicrophone(string phase, string? replyId = null)
    {
        _micLease.Stop(); var id = Interlocked.Exchange(ref _micId, null);
        Interlocked.Exchange(ref _microphone, null)?.Dispose();
        Interlocked.Exchange(ref _indicator, null)?.Dispose();
        if (id != null) Reply("microphone", id, true, new { phase });
        if (replyId != null && replyId != id) Reply("microphone", replyId, true, new { phase });
    }
    private void EndVerification(string phase)
    {
        var id = _verificationId; _verificationId = null;
        AppVerification.End(this);
        if (id != null)
        {
            Reply("verification", id, true, new { phase, reason = "application_result_not_observed" });
            Log.Info($"verification request={id} phase={phase} credential_released=false");
        }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _stop.Cancel(); StopMicrophone("off"); EndVerification("cancelled");
        _download?.Cancel(); _watch.Dispose(); _browser.Dispose();
        try { _channel.close(); } catch { }
    }
}
