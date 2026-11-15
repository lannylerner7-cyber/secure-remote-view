using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Agent;

/// <summary>Versioned, bounded, receipt-based stream; does not alter legacy Admin framing.</summary>
internal sealed class VerifiedFileChannel : IDisposable
{
    private readonly RTCDataChannel _channel;
    private readonly ToolBinding _binding;
    private readonly Func<bool> _current;
    private readonly Func<Task<bool>> _authorize;
    private readonly Func<bool> _lifetimeCurrent;
    private readonly Func<VerifiedFileInfo, string, bool, Task<bool>> _receipt;
    private readonly SessionFileBudget _budget;
    private readonly CancellationTokenSource _stop;
    private readonly Channel<(bool Text, byte[] Data)> _messages = Channel.CreateBounded<(bool, byte[])>(
        new BoundedChannelOptions(32) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private VerifiedFile? _incoming;
    private int _sending;
    private int _suspended;
    private long _authorizedAt;
    private int _authorizing;
    private string? _sendingId;
    private VerifiedFileInfo? _sendingInfo;
    private int _acked = -2;
    private bool _complete;
    private CancellationTokenSource? _sendStop;
    private long _lastActivity = Environment.TickCount64;
    private readonly Timer _watch;
    private readonly System.Collections.Generic.Dictionary<string, VerifiedFileInfo> _receipts = new();
    internal VerifiedFileChannel(RTCDataChannel channel, ToolBinding binding, Func<bool> current,
        SessionFileBudget budget, CancellationToken owner, Func<Task<bool>> authorize, Func<bool> lifetimeCurrent,
        Func<VerifiedFileInfo, string, bool, Task<bool>> receipt)
    {
        _channel = channel; _binding = binding; _current = current; _budget = budget;
        _authorize = authorize;
        _lifetimeCurrent = lifetimeCurrent;
        _receipt = receipt;
        _stop = CancellationTokenSource.CreateLinkedTokenSource(owner);
        _watch = new Timer(_ => {
            if (!_lifetimeCurrent())
                Dispose();
            else if (!_current() || (_incoming != null || _sending != 0) &&
                (Environment.TickCount64 - _lastActivity > 30_000 || Environment.TickCount64 - Interlocked.Read(ref _authorizedAt) > 5000))
                Suspend();
            else if ((_incoming != null || _sending != 0) && Environment.TickCount64 - Interlocked.Read(ref _authorizedAt) > 1000)
                _ = RefreshAuthority();
        }, null, 250, 250);
        channel.onmessage += (_, protocol, data) => {
            if (_stop.IsCancellationRequested || !_lifetimeCurrent() || data.Length > 16428 ||
                !_messages.Writer.TryWrite((protocol == DataChannelPayloadProtocols.WebRTC_String, data)))
                Dispose();
        };
        channel.onclose += Dispose;
        _ = Run();
    }
    private bool Current => !_stop.IsCancellationRequested && _current() && _channel.readyState == RTCDataChannelState.open &&
        ((_incoming == null && _sending == 0) || Environment.TickCount64 - Interlocked.Read(ref _authorizedAt) < 5000);
    private async Task<bool> RefreshAuthority()
    {
        if (Interlocked.Exchange(ref _authorizing,1) != 0)
            return Environment.TickCount64-Interlocked.Read(ref _authorizedAt)<5000;
        try
        {
            if (!await _authorize() || !_lifetimeCurrent())
            { Interlocked.Exchange(ref _authorizedAt,0); Suspend(); return false; }
            Interlocked.Exchange(ref _authorizedAt,Environment.TickCount64); return true;
        }
        catch { Interlocked.Exchange(ref _authorizedAt,0); Suspend(); return false; }
        finally { Interlocked.Exchange(ref _authorizing,0); }
    }
    private void Send(string type, object? value = null)
    {
        if (!Current) throw new IOException("file_authorization_changed");
        _channel.send(JsonSerializer.Serialize(new { type, version = 1, binding = _binding, value }));
    }
    private async Task Run()
    {
        try
        {
            await foreach (var message in _messages.Reader.ReadAllAsync(_stop.Token))
            {
                if (Interlocked.Exchange(ref _suspended, 0) != 0) { _incoming?.Dispose(); _incoming = null; }
                if (!Current || message.Data.Length == 0) continue;
                _lastActivity = Environment.TickCount64;
                try
                {
                    if (!message.Text)
                    {
                        if (_incoming == null) throw new IOException("file_not_started");
                        _incoming.Append(message.Data, () => Current);
                        Send("chunk_ack", new { id = _incoming.Info.id, sequence = _incoming.Sequence - 1 });
                        continue;
                    }
                    using var doc = JsonDocument.Parse(message.Data);
                    var root = doc.RootElement;
                    if (!_binding.Matches(root)) continue;
                    string? type = root.GetProperty("type").GetString();
                    var v = root.GetProperty("value");
                    if (type == "hello") Send("ready", new { protocol = 2 });
                    else if (type == "begin")
                    {
                        if (!await RefreshAuthority() || !Current) throw new IOException("file_authorization_changed");
                        var info = v.Deserialize<VerifiedFileInfo>() ?? throw new IOException("invalid_file_metadata");
                        if (_receipts.TryGetValue(info.id, out var receipt))
                        {
                            if (receipt != info) throw new IOException("file_identity_conflict");
                            Send("complete", new { id = info.id, size = info.size, sha256 = info.sha256 }); continue;
                        }
                        if (_incoming != null || !_budget.Reserve(info)) throw new IOException("file_busy_or_quota");
                        if (!await _receipt(info,"from_admin",false) || !Current) throw new IOException("file_quota_or_authority_unconfirmed");
                        _incoming = new VerifiedFile(info, FileTransfer.DropFolder);
                        Send("accepted", new { id = info.id });
                    }
                    else if (type == "end")
                    {
                        if (_incoming == null || v.GetProperty("id").GetString() != _incoming.Info.id)
                            throw new IOException("file_not_started");
                        var done = _incoming;
                        try
                        {
                            done.Complete(v.GetProperty("chunks").GetInt32(), v.GetProperty("sha256").GetString()!, () => Current);
                            if (!await _receipt(done.Info,"from_admin",true) || !Current) throw new IOException("file_terminal_receipt_unconfirmed");
                            _receipts[done.Info.id] = done.Info;
                            Send("complete", new { id = done.Info.id, size = done.Info.size, sha256 = done.Info.sha256 });
                        }
                        finally { done.Dispose(); _incoming = null; }
                    }
                    else if (type == "cancel")
                    {
                        if (_incoming is { } part && part.Info.id == v.GetProperty("id").GetString()) { part.Dispose(); _incoming = null; }
                        if (v.GetProperty("id").GetString() == _sendingId) _sendStop?.Cancel();
                        Send("cancelled", new { id = v.GetProperty("id").GetString() });
                    }
                    else if (v.TryGetProperty("id", out var id) && id.GetString() == _sendingId)
                    {
                        if (type == "accepted") Volatile.Write(ref _acked, -1);
                        else if (type == "chunk_ack") Volatile.Write(ref _acked, v.GetProperty("sequence").GetInt32());
                        else if (type == "complete" && _sendingInfo is { } sent &&
                            v.GetProperty("size").GetInt64() == sent.size && v.GetProperty("sha256").GetString() == sent.sha256)
                            _complete = true;
                        else if (type is "error" or "cancelled") _sendStop?.Cancel();
                    }
                }
                catch (Exception)
                {
                    var id = _incoming?.Info.id;
                    _incoming?.Dispose(); _incoming = null;
                    try { Send("error", new { id, reason = "file_integrity_or_authority_failed" }); } catch { }
                }
            }
        }
        catch (OperationCanceledException) { }
        finally { _incoming?.Dispose(); _incoming = null; }
    }
    internal async Task SendFile(RemoteFileAccess.ApprovedRead read, string id, string name, CancellationToken ct)
    {
        if (!await RefreshAuthority()) throw new IOException("file_authorization_changed");
        if (Interlocked.Exchange(ref _sending, 1) != 0) throw new IOException("file_busy");
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token, ct);
        _sendStop = lifetime; _sendingId = id; _acked = -2; _complete = false;
        try
        {
            var stream = read.Stream;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[VerifiedFile.ChunkSize];
            for (;;)
            {
                if (!Current) throw new IOException("authorization_changed");
                read.Validate();
                int n = await stream.ReadAsync(buffer, lifetime.Token); if (n == 0) break;
                hash.AppendData(buffer, 0, n); _lastActivity = Environment.TickCount64;
            }
            var info = new VerifiedFileInfo(id, FileTransfer.SafeName(name), stream.Length,
                Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(), "application/octet-stream");
            _sendingInfo = info;
            if (!_budget.Reserve(info)) throw new IOException("session_quota_exceeded");
            if (!await _receipt(info,"from_agent",false) || !Current) throw new IOException("file_quota_or_authority_unconfirmed");
            stream.Position = 0;
            Send("begin", info);
            await Wait(() => Volatile.Read(ref _acked) >= -1, lifetime.Token);
            int sequence = 0;
            for (;;)
            {
                read.Validate();
                int n = await stream.ReadAsync(buffer, lifetime.Token); if (n == 0) break;
                if (!Current) throw new IOException("authorization_changed");
                _channel.send(VerifiedFile.Encode(id, sequence, buffer, n));
                int sent = sequence++;
                await Wait(() => Volatile.Read(ref _acked) >= sent, lifetime.Token);
            }
            read.Validate();
            Send("end", new { id, chunks = sequence, sha256 = info.sha256 });
            await Wait(() => _complete, lifetime.Token); // End enqueued is NOT completion.
            if (!await _receipt(info,"from_agent",true)) throw new IOException("file_terminal_receipt_unconfirmed");
        }
        finally
        {
            _sendStop = null; _sendingId = null; _sendingInfo = null; Interlocked.Exchange(ref _sending, 0);
        }
    }
    private async Task Wait(Func<bool> received, CancellationToken ct)
    {
        long start = Environment.TickCount64;
        while (!received())
        {
            if (!Current || Environment.TickCount64 - start > 10_000) throw new IOException("file_receipt_unconfirmed");
            await Task.Delay(10, ct);
        }
        _lastActivity = Environment.TickCount64;
    }
    internal void Fail(string id, string reason)
    {
        try { Send("error", new { id, reason }); } catch { }
    }
    internal void Suspend()
    {
        _sendStop?.Cancel();
        // Queue ownership stays with Run; never dispose a stream under its write.
        if (_incoming is { } incoming && Interlocked.Exchange(ref _suspended, 1) == 0)
        {
            if (Current) Fail(incoming.Info.id, "protected_or_cancelled");
            _messages.Writer.TryWrite((false, Array.Empty<byte>()));
        }
    }
    public void Dispose()
    {
        if (_stop.IsCancellationRequested) return;
        _stop.Cancel(); _messages.Writer.TryComplete(); _watch.Dispose();
        try { _channel.close(); } catch { }
    }
}
