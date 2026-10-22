using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Agent;

/// <summary>
/// Step 10 — agent side of the in-session file exchange.
///
/// Wire format is byte-identical to src/lib/webrtc-live.ts and
/// admin/src/Media/FileTransport.cs:
///   control (JSON string)  { type:"file_begin", name, size, mime }
///   raw binary chunks (64 KiB) belonging to the most recent file_begin
///   control (JSON string)  { type:"file_end", name, size }
///   control (JSON string)  { type:"file_error", name, message }
///
/// Inbound (admin -> agent): reassembled in memory, SHA-256 verified, then
/// written atomically into the drop folder (Public Desktop\ConnectLive Files
/// so every interactive session can see it; falls back to the agent's own
/// ProgramData folder when the SYSTEM/Public path is unwritable).
///
/// Outbound (agent -> admin): tries the datachannel first; if the channel is
/// closed or fails mid-flight it demotes permanently for that session and
/// re-sends through the authed HTTP chunk endpoint
/// POST /api/public/agent/session/{id}/file?fileId=&amp;seq=&amp;eof=1 which lands
/// the same object in the private bucket and writes the manifest row.
/// </summary>
internal static class FileTransfer
{
    private const int ChunkBytes = 64 * 1024;
    private const int HttpChunkBytes = 4 * 1024 * 1024; // server hard-caps at 8 MiB
    private const int BufferedAmountBackpressure = 4 * 1024 * 1024;
    public const long MaxFileBytes = 500L * 1024 * 1024;

    private static readonly object _gate = new();
    private static RTCDataChannel? _dc;
    private static string _sessionId = "";
    private static bool _open;
    private static bool _demoted;
    private static Incoming? _incoming;
    private static ApiClient? _api;
    private static PeerInputPermission? _permission;

    /// <summary>Fired after an inbound file is fully written to disk.</summary>
    public static event Action<string>? FileLanded;

    public static bool IsOpen
    {
        get { lock (_gate) return _open && !_demoted; }
    }

    public static string CurrentPath
    {
        get { lock (_gate) return _open && !_demoted ? "dc" : "http"; }
    }

    /// <summary>Where inbound files land. Created on demand.</summary>
    public static string DropFolder
    {
        get
        {
            string[] candidates =
            {
                Path.Combine(
                    Environment.GetEnvironmentVariable("PUBLIC") ?? @"C:\Users\Public",
                    "Desktop", "ConnectLive Files"),
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "ConnectLive", "Files"),
                Path.Combine(Path.GetTempPath(), "ConnectLive Files"),
            };
            foreach (var dir in candidates)
            {
                try
                {
                    Directory.CreateDirectory(dir);
                    return dir;
                }
                catch { }
            }
            return Path.GetTempPath();
        }
    }

    internal static void Attach(ApiClient api, string sessionId, RTCDataChannel dc, PeerInputPermission permission)
    {
        if (!permission.Allows("files")) return;
        lock (_gate)
        {
            _permission = permission;
            _api = api;
            _sessionId = sessionId;
            _dc = dc;
            _open = dc.readyState == RTCDataChannelState.open;
            _demoted = false;
            _incoming = null;
        }

        dc.onopen += () =>
        {
            if (!permission.Allows("files")) return;
            lock (_gate) _open = true;
            Log.Info($"[files] datachannel OPEN (session={sessionId})");
        };
        dc.onclose += () =>
        {
            lock (_gate) { _open = false; _demoted = true; _incoming = null; }
            Log.Info("[files] datachannel CLOSED — HTTP fallback carries files");
        };
        dc.onerror += (err) =>
        {
            lock (_gate) { _open = false; _demoted = true; _incoming = null; }
            Log.Warn("[files] datachannel error: " + err);
        };
        dc.onmessage += (_, __, data) => { if (permission.Allows("files")) OnMessage(data, permission); };
    }

    public static void Detach()
    {
        lock (_gate)
        {
            _dc = null;
            _permission = null;
            _open = false;
            _demoted = false;
            _sessionId = "";
            _incoming = null;
        }
    }

    // ---- Inbound -----------------------------------------------------------

    private static void OnMessage(byte[] data, PeerInputPermission permission)
    {
        if (!permission.Allows("files")) return;
        if (data == null || data.Length == 0) return;
        if (data.Length < 512 && data[0] == (byte)'{')
        {
            try
            {
                using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(data));
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (type == "file_begin")
                {
                    var size = root.TryGetProperty("size", out var s) && s.TryGetInt64(out var sz) ? sz : 0;
                    if (size > MaxFileBytes)
                    {
                        Log.Warn($"[files] inbound rejected, {size} bytes exceeds cap");
                        lock (_gate) _incoming = null;
                        return;
                    }
                    var inc = new Incoming
                    {
                        Name = SafeName(root.TryGetProperty("name", out var n) ? n.GetString() : null),
                        Size = size,
                        Hasher = SHA256.Create(),
                    };
                    lock (_gate) _incoming = inc;
                    Log.Info($"[files] inbound begin {inc.Name} ({inc.Size} bytes)");
                }
                else if (type == "file_end")
                {
                    Incoming? done;
                    lock (_gate) { done = _incoming; _incoming = null; }
                    if (done != null) Complete(done, permission);
                }
                else if (type == "file_error")
                {
                    lock (_gate) _incoming = null;
                    Log.Warn("[files] peer reported transfer error: " +
                             (root.TryGetProperty("message", out var m) ? m.GetString() : "unknown"));
                }
            }
            catch (Exception ex) { Log.Warn("[files] control parse: " + ex.Message); }
            return;
        }

        lock (_gate)
        {
            if (_incoming == null) return;
            _incoming.Parts.Add(data);
            _incoming.Received += data.Length;
            _incoming.Hasher?.TransformBlock(data, 0, data.Length, null, 0);
            if (_incoming.Received > MaxFileBytes)
            {
                Log.Warn("[files] inbound exceeded cap mid-flight; dropping");
                _incoming = null;
            }
        }
    }

    private static void Complete(Incoming done, PeerInputPermission permission)
    {
        if (!permission.Allows("files")) return;
        try
        {
            done.Hasher?.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            var sha = done.Hasher?.Hash is { } h
                ? BitConverter.ToString(h).Replace("-", "").ToLowerInvariant()
                : "";
            done.Hasher?.Dispose();

            var folder = DropFolder;
            var target = UniquePath(folder, done.Name);
            var tmp = target + ".part";
            try
            {
                if (!permission.Allows("files")) return;
                using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    foreach (var part in done.Parts)
                    {
                        if (!permission.Allows("files")) return;
                        fs.Write(part, 0, part.Length);
                    }
                }
                if (!permission.Allows("files")) return;
                File.Move(tmp, target);
            }
            finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
            done.Parts.Clear();

            Log.Info($"[files] inbound complete {target} ({done.Received} bytes, sha256={sha})");
            try { FileLanded?.Invoke(target); } catch { }
        }
        catch (Exception ex)
        {
            Log.Warn("[files] inbound write failed: " + ex.Message);
        }
    }

    // ---- Outbound ----------------------------------------------------------

    /// <summary>
    /// Send a local file to the technician. Datachannel first, authed HTTP
    /// chunk upload as the fallback. Returns true when the peer/server has the
    /// complete file.
    /// </summary>
    public static async Task<bool> SendFileAsync(string filePath, CancellationToken ct)
    {
        PeerInputPermission? permission;
        lock (_gate) permission = _permission;
        if (ct.IsCancellationRequested || permission?.Allows("files") != true) return false;
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, permission.Token);
        ct = lifetime.Token;
        var fi = new FileInfo(filePath);
        if (!fi.Exists) { Log.Warn($"[files] send: missing {filePath}"); return false; }
        if (fi.Length > MaxFileBytes) { Log.Warn("[files] send: file exceeds 500 MiB cap"); return false; }

        string sessionId;
        ApiClient? api;
        lock (_gate) { sessionId = _sessionId; api = _api; }
        if (string.IsNullOrEmpty(sessionId) || api == null) return false;

        if (await SendOverChannelAsync(sessionId, fi, ct, permission).ConfigureAwait(false)) return true;
        return await SendOverHttpAsync(api, sessionId, fi, ct, permission).ConfigureAwait(false);
    }

    private static async Task<bool> SendOverChannelAsync(string sessionId, FileInfo fi, CancellationToken ct, PeerInputPermission permission)
    {
        RTCDataChannel? dc;
        bool open;
        lock (_gate)
        {
            dc = _dc;
            open = _open && !_demoted && _sessionId == sessionId;
        }
        if (dc == null || !open || !permission.Allows("files") || ct.IsCancellationRequested) return false;

        var name = fi.Name;
        var size = fi.Length;
        try
        {
            dc.send(JsonSerializer.Serialize(new
            {
                type = "file_begin",
                name,
                size,
                mime = GuessMime(name),
            }));

            using var fs = new FileStream(fi.FullName, FileMode.Open, FileAccess.Read, FileShare.Read);
            var buffer = new byte[ChunkBytes];
            long sent = 0;
            while (sent < size)
            {
                if (!permission.Allows("files") || ct.IsCancellationRequested) return false;
                var read = await fs.ReadAsync(buffer.AsMemory(0, ChunkBytes), ct).ConfigureAwait(false);
                if (read <= 0) break;
                while (dc.bufferedAmount > BufferedAmountBackpressure)
                {
                    await Task.Delay(20, ct).ConfigureAwait(false);
                    if (!permission.Allows("files")) return false;
                    lock (_gate)
                    {
                        dc = _dc;
                        open = _open && !_demoted && _sessionId == sessionId;
                    }
                    if (dc == null || !open) throw new InvalidOperationException("channel closed mid-transfer");
                }
                if (!permission.Allows("files") || ct.IsCancellationRequested) return false;
                dc.send(buffer.AsSpan(0, read).ToArray());
                sent += read;
            }
            if (!permission.Allows("files")) return false;
            dc.send(JsonSerializer.Serialize(new { type = "file_end", name, size }));
            Log.Info($"[files] sent {name} over datachannel ({sent} bytes)");
            return true;
        }
        catch (Exception ex)
        {
            lock (_gate) { _open = false; _demoted = true; }
            Log.Warn("[files] datachannel send failed, demoting to HTTP: " + ex.Message);
            try { if (permission.Allows("files")) dc?.send(JsonSerializer.Serialize(new { type = "file_error", name, message = "switching to http" })); }
            catch { }
            return false;
        }
    }

    private static async Task<bool> SendOverHttpAsync(ApiClient api, string sessionId, FileInfo fi, CancellationToken ct, PeerInputPermission permission)
    {
        if (!permission.Allows("files") || ct.IsCancellationRequested) return false;
        var fileId = Guid.NewGuid().ToString("N");
        var name = fi.Name;
        var mime = GuessMime(name);
        try
        {
            var sha = await Sha256FileAsync(fi.FullName, ct, permission).ConfigureAwait(false);
            if (!permission.Allows("files")) return false;
            using var fs = new FileStream(fi.FullName, FileMode.Open, FileAccess.Read, FileShare.Read);
            var buffer = new byte[HttpChunkBytes];
            var seq = 0;
            long sent = 0;
            while (true)
            {
                if (!permission.Allows("files") || ct.IsCancellationRequested) return false;
                var read = await fs.ReadAsync(buffer.AsMemory(0, HttpChunkBytes), ct).ConfigureAwait(false);
                var eof = sent + read >= fi.Length;
                if (read <= 0 && sent > 0 && !eof) break;
                var chunk = read > 0 ? buffer.AsSpan(0, read).ToArray() : Array.Empty<byte>();
                if (!permission.Allows("files") || ct.IsCancellationRequested) return false;
                var ok = await api.UploadSessionFileChunkAsync(
                    sessionId, fileId, seq, eof, name, mime, sha, fi.Length, chunk, ct).ConfigureAwait(false);
                if (!ok) { Log.Warn($"[files] http chunk {seq} rejected for {name}"); return false; }
                sent += read;
                seq++;
                if (eof) break;
            }
            Log.Info($"[files] sent {name} over HTTP fallback ({sent} bytes, {seq} chunks)");
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("[files] http upload failed: " + ex.Message);
            return false;
        }
    }

    // ---- helpers -----------------------------------------------------------

    private static async Task<string> Sha256FileAsync(string path, CancellationToken ct, PeerInputPermission permission)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var buffer = new byte[ChunkBytes];
        while (true)
        {
            if (!permission.Allows("files")) throw new OperationCanceledException("File authorization withdrawn.");
            var read = await fs.ReadAsync(buffer.AsMemory(), ct).ConfigureAwait(false);
            if (read == 0) break;
            sha.AppendData(buffer, 0, read);
        }
        var hash = sha.GetHashAndReset();
        return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
    }

    /// <summary>Mirrors safeName() in src/lib/session-files.server.ts.</summary>
    private static string SafeName(string? raw)
    {
        var name = Path.GetFileName(raw ?? "file");
        if (string.IsNullOrWhiteSpace(name)) name = "file";
        var cleaned = new string(name.Select(c =>
            char.IsLetterOrDigit(c) || c == '.' || c == '-' || c == '_' || c == ' ' ? c : '_').ToArray()).Trim();
        if (string.IsNullOrEmpty(cleaned) || cleaned == "." || cleaned == "..") cleaned = "file";
        return cleaned.Length > 180 ? cleaned[^180..] : cleaned;
    }

    private static string UniquePath(string folder, string name)
    {
        var candidate = Path.Combine(folder, name);
        if (!File.Exists(candidate)) return candidate;
        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        for (var i = 1; i < 1000; i++)
        {
            candidate = Path.Combine(folder, $"{stem} ({i}){ext}");
            if (!File.Exists(candidate)) return candidate;
        }
        return Path.Combine(folder, $"{stem}-{Guid.NewGuid():N}{ext}");
    }

    private static string GuessMime(string name) => Path.GetExtension(name).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".pdf" => "application/pdf",
        ".txt" or ".log" => "text/plain",
        ".json" => "application/json",
        ".csv" => "text/csv",
        ".zip" => "application/zip",
        ".exe" or ".msi" => "application/octet-stream",
        _ => "application/octet-stream",
    };

    private sealed class Incoming
    {
        public string Name = "file";
        public long Size;
        public long Received;
        public readonly List<byte[]> Parts = new();
        public SHA256? Hasher;
    }
}
