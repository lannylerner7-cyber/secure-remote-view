using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Input;

public static partial class InputTransport
{
    private static string? _permissionGrant;
    private static bool _refreshSupported;
    private sealed record PermissionRequest(string Id, string Mode, TaskCompletionSource<bool> Result);
    private static PermissionRequest? _permissionRequest;
    private static event Action<string, string, string, bool>? CurtainApplicationReceived;
    private static event Action? CommandChannelLost;

    private static bool ObserveCurtainApplication(string sessionId, RTCDataChannel channel, JsonElement message)
    {
        if (!message.TryGetProperty("kind", out var kind) || kind.GetString() != "action_status") return false;
        lock (_gate)
        {
            if (!ReferenceEquals(_dc, channel) || _permissionGrant == null ||
                !message.TryGetProperty("session_id", out var session) || session.GetString() != sessionId ||
                !message.TryGetProperty("authorization_id", out var grant) || grant.GetString() != _permissionGrant ||
                !message.TryGetProperty("request_id", out var request) || request.ValueKind != JsonValueKind.String ||
                !message.TryGetProperty("action", out var action) || action.GetString() is not ("curtain_on" or "curtain_off") ||
                !message.TryGetProperty("active", out var active) ||
                active.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return true;
            var applied = message.TryGetProperty("status", out var status) && status.GetString() == "applied" &&
                active.GetBoolean() == (action.GetString() == "curtain_on");
            CurtainApplicationReceived?.Invoke(sessionId, request.GetString()!, action.GetString()!, applied);
        }
        return true;
    }

    private static void ResetPermission()
    {
        _permissionRequest?.Result.TrySetException(new InvalidOperationException("The Agent command channel changed."));
        _permissionRequest = null; _permissionGrant = null; _refreshSupported = false;
        CommandChannelLost?.Invoke();
    }

    private static bool ObservePermission(string sessionId, RTCDataChannel channel, JsonElement message)
    {
        if (!message.TryGetProperty("kind", out var kind) || kind.GetString() != "permission_status") return false;
        lock (_gate)
        {
            if (!ReferenceEquals(_dc, channel) ||
                !message.TryGetProperty("session_id", out var session) || session.GetString() != sessionId ||
                !message.TryGetProperty("authorization_id", out var grant) || grant.ValueKind != JsonValueKind.String ||
                !Guid.TryParse(grant.GetString(), out _) ||
                !message.TryGetProperty("mode", out var mode) || mode.GetString() is not ("view" or "control"))
                return true;
            if (_permissionGrant != null && _permissionGrant != grant.GetString())
            { ResetPermission(); _demoted = true; return true; }
            _permissionGrant = grant.GetString();
            _refreshSupported = message.TryGetProperty("permission_refresh_supported", out var supported) &&
                supported.ValueKind == JsonValueKind.True;
            var pending = _permissionRequest;
            if (pending != null && message.TryGetProperty("request_id", out var request) && request.GetString() == pending.Id)
            {
                var applied = message.TryGetProperty("status", out var status) && status.GetString() == "applied" &&
                    mode.GetString() == pending.Mode;
                if (applied) pending.Result.TrySetResult(true);
                else pending.Result.TrySetException(new InvalidOperationException(
                    "The Agent could not confirm current control permission. Check authorization and the gateway."));
            }
        }
        return true;
    }

    public static async Task RefreshPermissionAsync(string sessionId, string mode, CancellationToken ct)
    {
        PermissionRequest pending;
        lock (_gate)
        {
            if (ct.IsCancellationRequested) ct.ThrowIfCancellationRequested();
            if (_sessionId != sessionId || !_open || _demoted || _dc == null || _permissionGrant == null)
                throw new InvalidOperationException("Wait for the Agent command channel before taking control.");
            if (!_refreshSupported)
                throw new InvalidOperationException("Update the Windows Agent to use the confirmed control handshake.");
            if (_permissionRequest != null)
                throw new InvalidOperationException("An Agent permission request is already pending.");
            pending = new PermissionRequest(Guid.NewGuid().ToString("D"), mode,
                new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously));
            _permissionRequest = pending;
            try
            {
                _dc.send(JsonSerializer.Serialize(new {
                    kind = "permission_refresh", payload = new {
                        request_id = pending.Id, mode, authorization_id = _permissionGrant,
                    },
                }));
            }
            catch { _permissionRequest = null; throw; }
        }
        try { await pending.Result.Task.WaitAsync(TimeSpan.FromSeconds(6), ct).ConfigureAwait(false); }
        finally { lock (_gate) { if (ReferenceEquals(_permissionRequest, pending)) _permissionRequest = null; } }
    }

    public static async Task ApplyCurtainAsync(string sessionId, string requestId, bool enabled, CancellationToken ct)
    {
        var result = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var action = enabled ? "curtain_on" : "curtain_off";
        void Receipt(string session, string request, string receivedAction, bool applied)
        {
            if (session != sessionId || request != requestId || receivedAction != action) return;
            if (applied) result.TrySetResult(true);
            else result.TrySetException(new InvalidOperationException(
                enabled ? "The Agent could not apply the privacy curtain. Control was not enabled."
                    : "The Agent did not confirm curtain release."));
        }
        void Lost() => result.TrySetException(new InvalidOperationException("The Agent command channel changed."));
        CurtainApplicationReceived += Receipt;
        CommandChannelLost += Lost;
        try
        {
            var payload = new { request_id = requestId, sent_at = Environment.TickCount64 };
            // Safety fallback never delays an otherwise confirmed peer release.
            if (!enabled) _ = SendRestAsync(sessionId, action, payload, ct).ContinueWith(
                task => { _ = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
            lock (_gate)
            {
                ct.ThrowIfCancellationRequested();
                if (_sessionId != sessionId || !_open || _demoted || _dc == null)
                    throw new InvalidOperationException("The Agent command channel is unavailable. Curtain state is unconfirmed.");
                _dc.send(JsonSerializer.Serialize(new { kind = action, payload }));
            }
            await result.Task.WaitAsync(TimeSpan.FromSeconds(3), ct).ConfigureAwait(false);
        }
        finally { CurtainApplicationReceived -= Receipt; CommandChannelLost -= Lost; }
    }
}
