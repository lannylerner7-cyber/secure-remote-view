using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace ConnectLive.Agent;

internal sealed record VerifiedFileInfo(string id, string name, long size, string sha256, string mime);

/// <summary>Production incremental receiver; portable tests compile this exact code.</summary>
internal sealed class VerifiedFile : IDisposable
{
    internal const int ChunkSize = 16384;
    internal const long SessionLimit = 5L * 1024 * 1024 * 1024;
    private readonly IncrementalHash _hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    private readonly FileStream _file;
    private readonly string _temp;
    private readonly RemotePathPin _folderPin;
    private bool _committed;
    internal VerifiedFileInfo Info { get; }
    internal long Received { get; private set; }
    internal int Sequence { get; private set; }
    internal VerifiedFile(VerifiedFileInfo info, string folder)
    {
        if (!Guid.TryParseExact(info.id, "D", out _) || info.size < 0 || info.size > FileTransfer.MaxFileBytes ||
            !System.Text.RegularExpressions.Regex.IsMatch(info.sha256, "^[a-f0-9]{64}$") ||
            string.IsNullOrEmpty(info.name) || info.name.Length > 180 || info.name.IndexOfAny(new[] { '/', '\\', ':', '\0' }) >= 0 ||
            info.name is "." or "..") throw new IOException("invalid_file_metadata");
        Info = info;
        Directory.CreateDirectory(folder);
        _folderPin = new RemotePathPin(folder);
        _temp = Path.Combine(folder, "." + info.id + ".part");
        try { _file = new FileStream(_temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536); }
        catch { _folderPin.Dispose(); throw; }
    }
    internal static byte[] Encode(string id, int sequence, byte[] bytes, int count)
    {
        var packet = new byte[44 + count];
        Encoding.ASCII.GetBytes("CLF2" + id).CopyTo(packet, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(packet.AsSpan(40, 4), sequence);
        bytes.AsSpan(0, count).CopyTo(packet.AsSpan(44));
        return packet;
    }
    internal void Append(byte[] packet, Func<bool> current)
    {
        if (!current()) throw new IOException("authorization_changed");
        if (packet.Length is < 45 or > ChunkSize + 44 || Encoding.ASCII.GetString(packet, 0, 4) != "CLF2" ||
            Encoding.ASCII.GetString(packet, 4, 36) != Info.id ||
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(packet.AsSpan(40, 4)) != Sequence ||
            Received + packet.Length - 44 > Info.size) throw new IOException("incomplete_or_reordered_file");
        _file.Write(packet, 44, packet.Length - 44);
        _hash.AppendData(packet, 44, packet.Length - 44);
        Received += packet.Length - 44; Sequence++;
    }
    internal string Complete(int chunks, string checksum, Func<bool> current)
    {
        if (!current() || Received != Info.size || chunks != Sequence || checksum != Info.sha256 ||
            Convert.ToHexString(_hash.GetHashAndReset()).ToLowerInvariant() != checksum)
            throw new IOException("file_integrity_failed");
        _file.Flush(true); _file.Dispose();
        if (!current()) throw new IOException("authorization_changed");
        // A deterministic destination makes a lost terminal receipt non-replayable.
        var destination = Path.Combine(Path.GetDirectoryName(_temp)!, Info.id + "-" + FileTransfer.SafeName(Info.name));
        File.Move(_temp, destination, false); _committed = true;
        return destination;
    }
    public void Dispose()
    {
        _file.Dispose(); _hash.Dispose();
        if (!_committed) { try { File.Delete(_temp); } catch { } }
        _folderPin.Dispose();
    }
}
