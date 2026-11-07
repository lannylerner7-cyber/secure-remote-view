using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ConnectLive.Admin.Api;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Input;

public sealed record WindowsUnlockState(string Phase, string? Reason = null);

/// <summary>Ephemeral, receipt-driven secure input. Never falls back to HTTP.</summary>
public sealed class WindowsUnlockChannel : IDisposable
{
    private readonly RTCDataChannel _channel;
    private readonly object _gate = new();
    private string? _request, _authorization;
    private long _sequence, _lastReceipt;
    private DateTimeOffset _expires;
    private bool _pinUsed, _disposed;
    private CancellationTokenSource? _lease;
    public string SessionId { get; }
    public string PeerId { get; }
    public WindowsUnlockState State { get; private set; } = new("idle");
    public bool Active => State.Phase is "starting" or "ready" or "submitted";
    public bool SuppressOrdinaryInput { get; private set; }
    public bool Ready => !_disposed && _channel.readyState == RTCDataChannelState.open;
    public event Action<WindowsUnlockState>? Changed;
    public WindowsUnlockChannel(string session, string peer, RTCDataChannel channel)
    {
        SessionId = session; PeerId = peer; _channel = channel;
        channel.onclose += () => End("blocked", "Unlock channel closed. No automatic retry.");
        channel.onerror += _ => End("blocked", "Unlock channel failed. No automatic retry.");
        channel.onmessage += (_, __, data) =>
        {
            if (data.Length > 4096) return;
            try
            {
                using var document = JsonDocument.Parse(data);
                var root = document.RootElement;
                lock (_gate)
                {
                    if (_disposed || !Active || root.GetProperty("kind").GetString() != "unlock_status" ||
                        root.GetProperty("session_id").GetString() != SessionId ||
                        root.GetProperty("authorization_id").GetString() != _authorization ||
                        root.GetProperty("request_id").GetString() != _request) return;
                    string? phase = root.GetProperty("phase").GetString();
                    if (phase is not ("starting" or "ready" or "submitted" or "unlocked" or "cancelled" or "blocked")) return;
                    _lastReceipt = Environment.TickCount64;
                    if (_pinUsed && phase is ("starting" or "ready")) return;
                    string? reason = root.TryGetProperty("reason", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;
                    if (phase is "unlocked" or "cancelled" or "blocked") End(phase, reason);
                    else Set(new(phase, reason));
                }
            }
            catch { /* Unbound or malformed peer messages never establish authority. */ }
        };
    }
    private void Set(WindowsUnlockState state) { State = state; Changed?.Invoke(state); }
    private bool Send(string kind, object? extra = null)
    {
        if (!Ready || _request == null) return false;
        var payload = new Dictionary<string, object?> { ["request_id"] = _request, ["sequence"] = ++_sequence };
        if (extra != null)
            foreach (var property in JsonSerializer.SerializeToElement(extra).EnumerateObject())
                payload[property.Name] = property.Value;
        try { _channel.send(JsonSerializer.Serialize(new { kind, payload })); return true; }
        catch { return false; }
    }
    public void Begin(WindowsUnlockTicket ticket, string authorization)
    {
        lock (_gate)
        {
            if (!Ready || Active || !Guid.TryParse(ticket.RequestId, out _) ||
                ticket.ExpiresAt <= DateTimeOffset.UtcNow || ticket.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(3))
                throw new InvalidOperationException("A current secure unlock channel and ticket are required.");
            _request = ticket.RequestId; _authorization = authorization; _sequence = 0; _pinUsed = false;
            _expires = ticket.ExpiresAt; _lastReceipt = Environment.TickCount64;
            SuppressOrdinaryInput = true;
            Set(new("starting"));
            if (!Send("unlock_begin", new { recording_stopped = true }))
            { End("blocked", "Unlock was not delivered. No retry."); return; }
            _lease = new CancellationTokenSource();
            _ = Lease(_lease.Token);
        }
    }
    private async Task Lease(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(1000, ct).ConfigureAwait(false);
                lock (_gate)
                {
                    if (!Active) return;
                    if (!Ready || DateTimeOffset.UtcNow >= _expires ||
                        Environment.TickCount64 - _lastReceipt > 5000 || !Send("unlock_renew"))
                    { End("blocked", "Unlock receipt expired. No automatic retry."); return; }
                }
            }
        }
        catch (OperationCanceledException) { }
    }
    public bool Input(string kind, object payload)
    {
        lock (_gate)
        {
            if (State.Phase != "ready" || _pinUsed) return false;
            bool sent = Send("unlock_input", new { input = new { kind, payload } });
            if (!sent) End("blocked", "Secure input was not delivered.");
            return sent;
        }
    }
    public bool SecureAttention()
    {
        lock (_gate) return State.Phase == "ready" && Send("unlock_sas");
    }
    public void UseSavedPin()
    {
        lock (_gate)
        {
            if (State.Phase != "ready" || _pinUsed) throw new InvalidOperationException("Start a new explicitly authorized attempt before submitting another PIN.");
            _pinUsed = true;
            Set(new("submitted", "Waiting for Windows; no retry."));
            if (!Send("unlock_pin", new { pin_field_confirmed = true })) End("blocked", "PIN delivery was not confirmed. No retry.");
        }
    }
    public void Cancel() { lock (_gate) { if (Active) { Send("unlock_cancel"); End("cancelled", "Operator cancelled."); } } }
    public void AllowOrdinaryInput() { lock (_gate) { if (!Active) SuppressOrdinaryInput = false; } }
    private void End(string phase, string? reason)
    {
        lock (_gate)
        {
            if (!Active) return;
            _lease?.Cancel(); _lease?.Dispose(); _lease = null;
            Set(new(phase, reason));
        }
    }
    public void Dispose() { lock (_gate) { Cancel(); _disposed = true; Changed = null; } }
}
