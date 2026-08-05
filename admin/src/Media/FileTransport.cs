using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using ConnectLive.Admin.Diag;
using SIPSorcery.Net;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Step 9 — file transfer over the dedicated WebRTC "files" data channel,
/// with a signed-URL HTTP fallback the moment the channel fails.
///
/// Wire format matches src/lib/webrtc-live.ts:
///   control frame (string)  { type:"file_begin", name, size, mime }
///   raw binary chunks (64 KiB) belonging to the most recent file_begin
///   control frame (string)  { type:"file_end", name, size }
///   control frame (string)  { type:"file_error", name, message }
///
/// Outbound files read from disk, chunk, and yield to the SCTP buffer. Inbound
/// files reassemble in memory, SHA-256 once complete, then surface a
/// FileReceived event. The operator decides whether to upload inbound files to
/// Supabase Storage (they already arrived on-disk via DataChannel, but the web
/// console and encrypted-zip path expect them in the bucket).
/// </summary>
public static class FileTransport
{
    private const int ChunkBytes = 64 * 1024;
    private const int BufferedAmountBackpressure = 4 * 1024 * 1024;

    private static readonly object _gate = new();
    private static RTCDataChannel? _dc;
    private static string _sessionId = "";
    private static bool _open;
    private static bool _demoted;

    private static Incoming? _incoming;
    private static readonly List<(string name, long size, byte[] bytes, SHA256? sha)> _inboundQueue = new();

    public static event Action<TransferEvent>? Progress;
    public static event Action<ReceivedFile>? FileReceived;

    public static string CurrentPath
    {
        get { lock (_gate) return _open && !_demoted ? "dc" : "http"; }
    }

    public static bool IsOpen
    {
        get { lock (_gate) return _open && !_demoted; }
    }

    public static void Attach(string sessionId, RTCDataChannel dc)
    {
        lock (_gate)
        {
            Detach();
            _sessionId = sessionId;
            _dc = dc;
            _open = false;
            _demoted = false;
        }
        dc.onopen += () =>
        {
            lock (_gate) _open = true;
            Log.Write($"[files] datachannel OPEN (session={sessionId})");
        };
        dc.onclose += () =>
        {
            lock (_gate) { _open = false; _demoted = true; }
            _incoming = null;
            Log.Write("[files] datachannel CLOSED — HTTP fallback carries files");
        };
        dc.onerror += (err) =>
        {
            lock (_gate) { _open = false; _demoted = true; }
            _incoming = null;
            Log.Write("[files] datachannel error: " + err);
        };
        dc.onmessage += (_, __, data) => OnMessage(data);
    }

    public static void Detach()
    {
        lock (_gate)
        {
            _dc = null;
            _open = false;
            _demoted = false;
            _sessionId = "";
            _incoming = null;
        }
    }

    /// <summary>
    /// Send a file from disk over the data channel, or return false so the
    /// caller can retry via the HTTP signed upload path.
    /// </summary>
    public static async Task<bool> SendFileAsync(string sessionId, string filePath,
        string mime, IProgress<TransferEvent>? progress, CancellationToken ct)
    {
        var fi = new FileInfo(filePath);
        if (!fi.Exists) return false;
        var name = Path.GetFileName(filePath);
        var size = fi.Length;
        if (size > MaxFileBytes) return false;

        RTCDataChannel? dc;
        bool open;
        lock (_gate)
        {
            dc = _dc;
            open = _open && !_demoted && _sessionId == sessionId;
        }
        if (dc == null || !open) return false;

        void Fire(TransferEvent ev)
        {
            progress?.Report(ev);
            try { Progress?.Invoke(ev); } catch { }
        }

        try
        {
            Fire(new TransferEvent(TransferKind.Begin, name, size, 0, null));
            dc.send(JsonSerializer.Serialize(new { type = "file_begin", name, size, mime }));

            long offset = 0;
            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var buffer = new byte[ChunkBytes];
            while (offset < size)
            {
                var read = await fs.ReadAsync(buffer.AsMemory(0, ChunkBytes), ct).ConfigureAwait(false);
                if (read <= 0) break;
                while (dc.bufferedAmount > BufferedAmountBackpressure)
                {
                    await Task.Delay(20, ct).ConfigureAwait(false);
                    lock (_gate)
                    {
                        dc = _dc;
                        open = _open && !_demoted && _sessionId == sessionId;
                    }
                    if (dc == null || !open) throw new InvalidOperationException("channel closed");
                }
                dc.send(buffer.AsSpan(0, read).ToArray());
                offset += read;
                Fire(new TransferEvent(TransferKind.Progress, name, size, offset, null));
            }
            dc.send(JsonSerializer.Serialize(new { type = "file_end", name, size }));
            Fire(new TransferEvent(TransferKind.Sent, name, size, offset, null));
            return true;
        }
        catch (Exception ex)
        {
            lock (_gate) { _open = false; _demoted = true; }
            _incoming = null;
            Log.Write("[files] send failed, demoting to HTTP: " + ex.Message);
            Fire(new TransferEvent(TransferKind.Error, name, size, 0, ex.Message));
            return false;
        }
    }

    private static void OnMessage(byte[] data)
    {
        if (data.Length == 0) return;
        // Control frames are JSON strings. Binary payloads are raw chunks.
        if (data.Length < 512 && data[0] == (byte)'{')
        {
            try
            {
                var json = Encoding.UTF8.GetString(data);
                var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (type == "file_begin")
                {
                    _incoming = new Incoming
                    {
                        Name = root.TryGetProperty("name", out var n) ? n.GetString() ?? "file" : "file",
                        Mime = root.TryGetProperty("mime", out var m) ? m.GetString() ?? "application/octet-stream" : "application/octet-stream",
                        Size = root.TryGetProperty("size", out var s) && s.TryGetInt64(out var sz) ? sz : 0,
                        Parts = new List<byte[]>(),
                        Hasher = SHA256.Create(),
                    };
                    FireSafe(new TransferEvent(TransferKind.Begin, _incoming.Name, _incoming.Size, 0, null));
                }
                else if (type == "file_end" && _incoming != null)
                {
                    var done = _incoming;
                    _incoming = null;
                    done.Hasher.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                    var sha = BitConverter.ToString(done.Hasher.Hash ?? Array.Empty<byte>()).Replace("-", "").ToLowerInvariant();
                    var bytes = Combine(done.Parts);
                    FireSafe(new TransferEvent(TransferKind.Complete, done.Name, done.Size, bytes.LongLength, sha));
                    FireSafeFile(new ReceivedFile(done.Name, done.Mime, bytes, sha));
                }
                else if (type == "file_error" && _incoming != null)
                {
                    var name = _incoming.Name;
                    _incoming = null;
                    FireSafe(new TransferEvent(TransferKind.Error, name, 0, 0,
                        root.TryGetProperty("message", out var msg) ? msg.GetString() : "transfer failed"));
                }
            }
            catch (Exception ex) { Log.Write("[files] control parse: " + ex.Message); }
            return;
        }
        if (_incoming == null) return;
        _incoming.Parts.Add(data);
        _incoming.Hasher.TransformBlock(data, 0, data.Length, null, 0);
        FireSafe(new TransferEvent(TransferKind.Progress, _incoming.Name, _incoming.Size,
            Math.Min(_incoming.Size, _incoming.Parts.Sum(p => (long)p.Length)), null));
    }

    private static byte[] Combine(List<byte[]> parts)
    {
        var total = parts.Sum(p => (long)p.Length);
        if (total > int.MaxValue) throw new InvalidOperationException("incoming file exceeds 2 GiB");
        var result = new byte[total];
        var offset = 0;
        foreach (var part in parts)
        {
            Buffer.BlockCopy(part, 0, result, offset, part.Length);
            offset += part.Length;
        }
        return result;
    }

    private static void FireSafe(TransferEvent ev)
    {
        try { Progress?.Invoke(ev); } catch { }
    }

    private static void FireSafeFile(ReceivedFile f)
    {
        try { FileReceived?.Invoke(f); } catch { }
    }

    public const long MaxFileBytes = 500L * 1024 * 1024;
    public const long MaxSessionBytes = 5L * 1024 * 1024 * 1024;

    public enum TransferKind { Begin, Progress, Complete, Sent, Error }

    public sealed class TransferEvent
    {
        public TransferKind Kind { get; }
        public string Name { get; }
        public long Size { get; }
        public long Bytes { get; }
        public string? Sha256 { get; }
        public TransferEvent(TransferKind kind, string name, long size, long bytes, string? sha256)
        {
            Kind = kind;
            Name = name;
            Size = size;
            Bytes = bytes;
            Sha256 = sha256;
        }
    }

    public sealed class ReceivedFile
    {
        public string Name { get; }
        public string Mime { get; }
        public byte[] Bytes { get; }
        public string Sha256 { get; }
        public ReceivedFile(string name, string mime, byte[] bytes, string sha256)
        {
            Name = name;
            Mime = mime;
            Bytes = bytes;
            Sha256 = sha256;
        }
    }

    private class Incoming
    {
        public string Name = "";
        public string Mime = "application/octet-stream";
        public long Size;
        public List<byte[]> Parts = new();
        public SHA256? Hasher;
    }
}
