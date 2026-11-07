using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using ConnectLive.Unlock;

namespace ConnectLive.Agent;

internal sealed class UnlockOperation : IDisposable
{
    private static int _sensitive;
    internal static bool Sensitive => Volatile.Read(ref _sensitive) != 0;
    private readonly ApiClient _api;
    private readonly UnlockIdentity _identity;
    private readonly string _session, _peer, _request;
    private readonly Func<bool> _current;
    private readonly Action<string, string?> _report;
    private readonly Action<byte[], int, int> _frame;
    private readonly CancellationTokenSource _stop;
    private readonly SemaphoreSlim _pipeGate = new(1);
    private readonly Channel<(string Kind, JsonElement Payload)> _inputs = Channel.CreateBounded<(string, JsonElement)>(
        new BoundedChannelOptions(32) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private NamedPipeClientStream? _pipe;
    private long _lastBrowser = Environment.TickCount64, _lastPermit, _lastSequence;
    private long _pinAt;
    private int _finished, _pinConsumed;
    private bool _acquired;
    internal string RequestId => _request;
    internal bool Active => Volatile.Read(ref _finished) == 0;

    internal UnlockOperation(ApiClient api, UnlockIdentity identity, string session, string peer, string request,
        CancellationToken owner, Func<bool> current, Action<string, string?> report, Action<byte[], int, int> frame)
    {
        _api = api; _identity = identity; _session = session; _peer = peer; _request = request;
        _current = current; _report = report; _frame = frame;
        _stop = CancellationTokenSource.CreateLinkedTokenSource(owner);
        _stop.CancelAfter(TimeSpan.FromSeconds(120));
        Interlocked.Increment(ref _sensitive);
    }
    private bool Valid => Active && !_stop.IsCancellationRequested && _current() &&
        UnlockEnrollment.Matches(_api, _identity) &&
        UnlockEnrollment.Current?.KeyId == _identity.KeyId &&
        UnlockEnrollment.HasLocalOptIn &&
        Environment.TickCount64 - Interlocked.Read(ref _lastBrowser) < 5000;
    private object Request(string action, bool osUnlocked = false) => action == "end"
        ? new { action, keyId = _identity.KeyId, requestId = _request, sessionId = _session, peerId = _peer, osUnlocked } as object
        : new { action, keyId = _identity.KeyId, requestId = _request, sessionId = _session, peerId = _peer };
    private async Task<JsonDocument> Server(string action, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMilliseconds(2000));
        return await _api.UnlockRequestAsync(Request(action), deadline.Token);
    }
    private async Task<JsonDocument> Exchange(object payload, bool frame = false)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(2));
        await _pipeGate.WaitAsync(deadline.Token);
        try
        {
            if (!Valid || _pipe == null || Environment.TickCount64 - Interlocked.Read(ref _lastPermit) > 5000)
                throw new IOException("unlock_authority_expired");
            await UnlockPipe.WriteAsync(_pipe, payload, deadline.Token);
            return await UnlockPipe.ReadAsync(_pipe, deadline.Token, frame);
        }
        finally { _pipeGate.Release(); }
    }
    internal void Receive(string kind, JsonElement payload)
    {
        if (!Active || payload.GetProperty("request_id").GetString() != _request ||
            !payload.TryGetProperty("sequence", out var sequence) || !sequence.TryGetInt64(out var n) ||
            n <= Interlocked.Read(ref _lastSequence)) return;
        Interlocked.Exchange(ref _lastSequence, n);
        if (kind == "unlock_cancel") { Finish("cancelled", "operator_cancelled"); return; }
        if (!Valid) { Finish("blocked", "unlock_authority_expired"); return; }
        Interlocked.Exchange(ref _lastBrowser, Environment.TickCount64);
        if (kind == "unlock_renew") return;
        if (kind is not ("unlock_input" or "unlock_pin" or "unlock_sas")) return;
        if (!_inputs.Writer.TryWrite((kind, payload.Clone()))) Finish("blocked", "unlock_input_overloaded");
    }
    internal async Task RunAsync()
    {
        try
        {
            if (!Valid || WindowsSession.Locked(WindowsSession.CurrentId) != true)
                throw new IOException("unlock_not_locked");
            using (var acquired = await Server("acquire", _stop.Token))
            {
                if (!acquired.RootElement.TryGetProperty("allowed", out var allowed) || allowed.ValueKind != JsonValueKind.True)
                    throw new IOException("unlock_request_rejected");
                _acquired = true;
                Interlocked.Exchange(ref _lastPermit, Environment.TickCount64);
            }
            using (var broker = await UnlockEnrollment.BrokerAsync("begin", _identity, _stop.Token))
            {
                if (!broker.RootElement.TryGetProperty("pipe", out var name) || name.GetString() is not { } pipeName)
                    throw new IOException("unlock_helper_unavailable");
                _pipe = await UnlockPipe.ConnectAsync(pipeName, _stop.Token, broker.RootElement.GetProperty("helperPid").GetInt32());
            }
            _report("starting", null);
            await Task.WhenAll(PumpFrames(), PumpInput(), PermitLoop());
        }
        catch (OperationCanceledException) { Finish("blocked", "unlock_cancelled_or_expired"); }
        catch { Finish("blocked", "unlock_unavailable_no_retry"); }
        finally
        {
            Finish("blocked", "unlock_ended");
            _stop.Dispose();
            _pipeGate.Dispose();
        }
    }
    private async Task PermitLoop()
    {
        try
        {
            while (Valid)
            {
                await Task.Delay(2000, _stop.Token);
                using var result = await Server("permit", _stop.Token);
                if (!Valid || result.RootElement.GetProperty("allowed").ValueKind != JsonValueKind.True) break;
                Interlocked.Exchange(ref _lastPermit, Environment.TickCount64);
            }
        }
        catch { }
        Finish("blocked", "unlock_authority_expired");
    }
    private async Task PumpFrames()
    {
        try
        {
            while (Valid)
            {
                using var result = await Exchange(new { action = "frame" }, frame: true);
                var value = result.RootElement;
                if (value.GetProperty("phase").GetString() == "unlocked")
                {
                    if (WindowsSession.Locked(WindowsSession.CurrentId) == false)
                        Finish("unlocked", null);
                    else Finish("blocked", "unlock_state_unconfirmed");
                    return;
                }
                if (!Valid || WindowsSession.Locked(WindowsSession.CurrentId) != true) break;
                var bytes = value.GetProperty("frame").GetBytesFromBase64();
                if (bytes.Length > 4 * 1024 * 1024) throw new IOException("unlock_frame_too_large");
                using var stream = new MemoryStream(bytes, false);
                using var source = new Bitmap(stream);
                int w = source.Width, h = source.Height;
                if (w is < 2 or > 1920 || h is < 2 or > 1920 || (w & 1) != 0 || (h & 1) != 0)
                    throw new IOException("unlock_frame_invalid");
                using var bitmap = new Bitmap(w, h, PixelFormat.Format32bppRgb);
                using (var g = Graphics.FromImage(bitmap)) g.DrawImageUnscaled(source, 0, 0);
                var locked = bitmap.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
                var raw = new byte[w * h * 4];
                try
                {
                    for (int row = 0; row < h; row++) Marshal.Copy(IntPtr.Add(locked.Scan0, row * locked.Stride), raw, row * w * 4, w * 4);
                    for (int i = 0; i < raw.Length; i += 4) { (raw[i], raw[i + 2]) = (raw[i + 2], raw[i]); raw[i + 3] = 255; }
                    if (Valid && WindowsSession.Locked(WindowsSession.CurrentId) == true) _frame(raw, w, h);
                }
                // PushFrame may hand ownership to the hardware encoder. Do
                // not zero a buffer while that encoder is still consuming it.
                finally { bitmap.UnlockBits(locked); }
                if (_pinAt != 0 && Environment.TickCount64 - _pinAt > 10_000)
                { Finish("blocked", "windows_still_locked_no_retry"); return; }
                _report(_pinAt == 0 ? "ready" : "submitted", null);
                await Task.Delay(200, _stop.Token);
            }
        }
        catch { }
        FinishAfterIo("secure_desktop_unavailable");
    }
    private async Task PumpInput()
    {
        try
        {
            await foreach (var item in _inputs.Reader.ReadAllAsync(_stop.Token))
            {
                if (!Valid) break;
                if (item.Kind == "unlock_pin")
                {
                    if (!item.Payload.TryGetProperty("pin_field_confirmed", out var confirmed) ||
                        confirmed.ValueKind != JsonValueKind.True || Interlocked.Exchange(ref _pinConsumed, 1) != 0)
                        throw new IOException("unlock_pin_already_used");
                    using var credential = await Server("pin", _stop.Token);
                    if (!Valid) break;
                    var pin = UnlockEnrollment.OpenPin(credential.RootElement.GetProperty("sealedPin"), _identity);
                    try
                    {
                        using var applied = await Exchange(new { action = "pin", pinUtf8 = pin });
                        _pinAt = Environment.TickCount64;
                        _report("submitted", "waiting_for_windows_no_retry");
                    }
                    finally { CryptographicOperations.ZeroMemory(pin); }
                }
                else if (item.Kind == "unlock_sas")
                {
                    using var sas = await UnlockEnrollment.BrokerAsync("sas", _identity, _stop.Token);
                    if (!sas.RootElement.TryGetProperty("requested", out _)) throw new IOException("secure_attention_unavailable");
                }
                else
                {
                    if (_pinAt != 0) continue;
                    using var applied = await Exchange(new { action = "input", input = item.Payload.GetProperty("input") });
                }
            }
        }
        catch { FinishAfterIo("unlock_input_rejected_no_retry"); }
    }
    private void FinishAfterIo(string reason)
    {
        // Hello can submit automatically and close LogonUI/its pipe between
        // the final character and its receipt. Only a fresh OS query, never
        // a successful send or a picture, may turn that transition into success.
        if (_acquired && _pipe != null && Valid && WindowsSession.Locked(WindowsSession.CurrentId) == false)
            Finish("unlocked", null);
        else Finish("blocked", reason);
    }
    private void Finish(string phase, string? reason)
    {
        if (Interlocked.Exchange(ref _finished, 1) != 0) return;
        try { _report(phase, reason); } catch { }
        _stop.Cancel();
        _inputs.Writer.TryComplete();
        while (_inputs.Reader.TryRead(out _)) { }
        try { _pipe?.Dispose(); } catch { }
        Interlocked.Decrement(ref _sensitive);
        if (_acquired) _ = EndReceipt(phase == "unlocked");
    }
    private async Task EndReceipt(bool unlocked)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try { using var result = await _api.UnlockRequestAsync(Request("end", unlocked), deadline.Token); }
        catch { /* No retries or invented success receipt. */ }
    }
    public void Dispose() => Finish("cancelled", "peer_closed");
}
