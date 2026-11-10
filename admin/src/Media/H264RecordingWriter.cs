using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Writes received Annex-B H.264 access units to a playable Matroska file.
/// Starts at an IDR with SPS/PPS, stores AVC codec-private data and length-prefixed
/// NALs, and patches duration at Stop. No encoder, native DLL or external process.
/// A changed codec configuration ends the segment instead of corrupting its track.
/// </summary>
public sealed class H264RecordingWriter : IEncodedRecording
{
    private readonly object _gate = new();
    private readonly Func<long> _clock;
    private FileStream? _stream;
    private readonly int _width, _height;
    private byte[]? _sps, _pps;
    private bool _headerWritten;
    private bool _writeFailed;
    private long _durationPosition, _firstTime, _lastTime, _lastDelta = 33;
    private uint _frames;
    public string Path { get; }
    public uint FrameCount { get { lock (_gate) return _frames; } }

    public H264RecordingWriter(string path, int width, int height, Func<long>? clock = null,
        byte[]? sps = null, byte[]? pps = null)
    {
        if (width <= 0 || height <= 0 || width > 32768 || height > 32768)
            throw new ArgumentOutOfRangeException(nameof(width), "Live video dimensions are not ready.");
        Path = path; _width = width; _height = height;
        _clock = clock ?? (() => Environment.TickCount64);
        _sps = sps?.ToArray(); _pps = pps?.ToArray();
        var directory = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        _stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
    }

    public void WriteFrame(byte[] frame)
    {
        if (frame == null || frame.Length == 0) return;
        if (frame.Length > 16 * 1024 * 1024) throw new InvalidDataException("H.264 frame exceeds recording limit.");
        lock (_gate)
        {
            if (_stream == null) return;
            try
            {
            var nals = SplitAnnexB(frame);
            bool key = nals.Any(n => (n[0] & 31) == 5);
            foreach (var nal in nals)
            {
                var type = nal[0] & 31;
                if (type != 7 && type != 8) continue;
                if (nal.Length > ushort.MaxValue) throw new InvalidDataException("Invalid H.264 parameter set.");
                var previous = type == 7 ? _sps : _pps;
                if (_headerWritten && (previous == null || !previous.SequenceEqual(nal)))
                    throw new InvalidDataException("Video encoder settings changed. Start a new recording.");
                if (type == 7) _sps = nal; else _pps = nal;
            }
            if (!nals.Any(n => (n[0] & 31) is 1 or 5)) return;
            if (!_headerWritten)
            {
                // P-frames before the requested keyframe are not decodable.
                if (!key || _sps is not { Length: >= 4 } || _pps == null) return;
                WriteHeader();
                _firstTime = _clock();
            }
            long elapsed = Math.Max(_lastTime, _clock() - _firstTime);
            using var block = new MemoryStream();
            block.Write(new byte[] { 0x81, 0, 0, key ? (byte)0x80 : (byte)0 });
            foreach (var nal in nals)
            {
                block.Write(new byte[] { (byte)(nal.Length >> 24), (byte)(nal.Length >> 16),
                    (byte)(nal.Length >> 8), (byte)nal.Length });
                block.Write(nal);
            }
            // A cluster per frame keeps relative timecodes bounded and makes
            // partially interrupted files readable without an index.
            _stream.Write(Element(0x1F43B675, Join(
                Element(0xE7, Unsigned((ulong)elapsed)), Element(0xA3, block.ToArray()))));
            _stream.Flush();
            if (_frames > 0 && elapsed > _lastTime) _lastDelta = elapsed - _lastTime;
            _lastTime = elapsed;
            _frames++;
            }
            catch (Exception ex) when ((ex is IOException && ex is not InvalidDataException) ||
                ex is UnauthorizedAccessException)
            {
                _writeFailed = true;
                throw;
            }
        }
    }

    private void WriteHeader()
    {
        var stream = _stream!;
        stream.Write(Element(0x1A45DFA3, Join(
            Element(0x4286, Unsigned(1)), Element(0x42F7, Unsigned(1)),
            Element(0x42F2, Unsigned(4)), Element(0x42F3, Unsigned(8)),
            Element(0x4282, Encoding.ASCII.GetBytes("matroska")),
            Element(0x4287, Unsigned(4)), Element(0x4285, Unsigned(2)))));
        stream.Write(Id(0x18538067));
        stream.Write(new byte[] { 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff });
        var info = Join(Element(0x2AD7B1, Unsigned(1_000_000)),
            Element(0x4D80, Encoding.UTF8.GetBytes("ConnectLive")),
            Element(0x5741, Encoding.UTF8.GetBytes("ConnectLive")));
        var duration = Element(0x4489, new byte[8]);
        var infoSize = Size(info.Length + duration.Length);
        _durationPosition = stream.Position + Id(0x1549A966).Length + infoSize.Length
            + info.Length + Id(0x4489).Length + Size(8).Length;
        stream.Write(Element(0x1549A966, Join(info, duration)));
        var sps = _sps!; var pps = _pps!;
        var avc = Join(new byte[] { 1, sps[1], sps[2], sps[3], 0xff, 0xe1,
            (byte)(sps.Length >> 8), (byte)sps.Length }, sps,
            new byte[] { 1, (byte)(pps.Length >> 8), (byte)pps.Length }, pps);
        stream.Write(Element(0x1654AE6B, Element(0xAE, Join(
            Element(0xD7, Unsigned(1)), Element(0x73C5, Unsigned(1)),
            Element(0x83, Unsigned(1)), Element(0x9C, Unsigned(0)),
            Element(0x86, Encoding.ASCII.GetBytes("V_MPEG4/ISO/AVC")),
            Element(0x63A2, avc),
            Element(0xE0, Join(Element(0xB0, Unsigned((ulong)_width)),
                Element(0xBA, Unsigned((ulong)_height))))))));
        _headerWritten = true;
    }

    public string? Stop()
    {
        lock (_gate)
        {
            var stream = _stream;
            _stream = null;
            if (_writeFailed)
            {
                stream?.Dispose();
                throw new IOException("A partial recording write failed; the file is not confirmed playable.");
            }
            if (stream != null)
            {
                try
                {
                    if (_frames > 0)
                    {
                        var duration = BitConverter.GetBytes((double)(_lastTime + _lastDelta));
                        if (BitConverter.IsLittleEndian) Array.Reverse(duration);
                        stream.Position = _durationPosition;
                        stream.Write(duration);
                        stream.Flush();
                    }
                }
                finally { stream.Dispose(); }
            }
            if (_frames > 0) return Path;
            if (File.Exists(Path)) File.Delete(Path);
            return null;
        }
    }
    public void Dispose() => Stop();

    /// <summary>Keep only codec headers, not footage. Some encoders send them
    /// once per connection rather than with every requested IDR.</summary>
    public static void ReadParameterSets(byte[] frame, ref byte[]? sps, ref byte[]? pps)
    {
        int start = -1;
        for (int i = 0; i + 2 < frame.Length; i++)
        {
            if (frame[i] != 0 || frame[i + 1] != 0) continue;
            int prefix = frame[i + 2] == 1 ? 3 :
                i + 3 < frame.Length && frame[i + 2] == 0 && frame[i + 3] == 1 ? 4 : 0;
            if (prefix == 0) continue;
            CopyParameterSet(frame, start, i, ref sps, ref pps);
            start = i + prefix; i = start - 1;
        }
        CopyParameterSet(frame, start, frame.Length, ref sps, ref pps);
    }
    private static void CopyParameterSet(byte[] frame, int start, int end, ref byte[]? sps, ref byte[]? pps)
    {
        if (start < 0 || end <= start || end - start > ushort.MaxValue) return;
        var type = frame[start] & 31;
        if (type == 7 && end - start >= 4) sps = frame[start..end];
        else if (type == 8) pps = frame[start..end];
    }

    private static List<byte[]> SplitAnnexB(byte[] bytes)
    {
        var result = new List<byte[]>();
        int start = -1;
        for (int i = 0; i + 2 < bytes.Length; i++)
        {
            if (bytes[i] != 0 || bytes[i + 1] != 0) continue;
            int prefix = bytes[i + 2] == 1 ? 3 :
                i + 3 < bytes.Length && bytes[i + 2] == 0 && bytes[i + 3] == 1 ? 4 : 0;
            if (prefix == 0) continue;
            if (start >= 0 && i > start) result.Add(bytes[start..i]);
            start = i + prefix;
            i = start - 1;
        }
        if (start >= 0 && start < bytes.Length) result.Add(bytes[start..]);
        if (result.Count == 0) throw new InvalidDataException("Expected an Annex-B H.264 access unit.");
        return result;
    }
    private static byte[] Id(uint value)
    {
        var bytes = new byte[] { (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value };
        int offset = 0; while (offset < 3 && bytes[offset] == 0) offset++;
        return bytes[offset..];
    }
    private static byte[] Unsigned(ulong value)
    {
        var bytes = new byte[8];
        for (int i = 7; i >= 0; i--) { bytes[i] = (byte)value; value >>= 8; }
        int offset = 0; while (offset < 7 && bytes[offset] == 0) offset++;
        return bytes[offset..];
    }
    private static byte[] Size(int length)
    {
        int width = 1;
        while ((ulong)length >= (1UL << (7 * width)) - 1) width++;
        ulong value = (uint)length | (1UL << (7 * width));
        var bytes = new byte[width];
        for (int i = width - 1; i >= 0; i--) { bytes[i] = (byte)value; value >>= 8; }
        return bytes;
    }
    private static byte[] Element(uint id, byte[] data) => Join(Id(id), Size(data.Length), data);
    private static byte[] Join(params byte[][] parts)
    {
        var result = new byte[parts.Sum(part => part.Length)];
        int offset = 0;
        foreach (var part in parts) { part.CopyTo(result, offset); offset += part.Length; }
        return result;
    }
}
