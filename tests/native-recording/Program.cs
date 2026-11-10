using ConnectLive.Admin.Media;

if (args.Length != 2) throw new ArgumentException("Pass an Annex-B fixture and an output directory.");
var bytes = File.ReadAllBytes(args[0]);
var outDir = args[1];
Directory.CreateDirectory(outDir);
var offsets = new List<int>();
for (int i = 0; i + 4 < bytes.Length; i++)
{
    int prefix = bytes[i] == 0 && bytes[i + 1] == 0
        ? bytes[i + 2] == 1 ? 3 : bytes[i + 2] == 0 && bytes[i + 3] == 1 ? 4 : 0 : 0;
    if (prefix == 0) continue;
    if ((bytes[i + prefix] & 31) == 9) offsets.Add(i);
    i += prefix - 1;
}
offsets.Add(bytes.Length);
var frames = offsets.Zip(offsets.Skip(1), (a, b) => bytes[a..b]).ToArray();
Check(frames.Length >= 30, "fixture has advancing H.264 access units");
long now = 0;
var path = Path.Combine(outDir, "h264-negotiated.mkv");
using (var writer = new H264RecordingWriter(path, 64, 48, () => now))
{
    foreach (var frame in frames) { writer.WriteFrame(frame); now += 1000 / 12; }
    Check(writer.FrameCount == frames.Length, "every access unit stored");
    Check(writer.Stop() == path, "completed file returned");
    Check(writer.Stop() == path, "Stop is idempotent");
}
Check(File.ReadAllBytes(path).AsSpan(0, 4).SequenceEqual(new byte[] { 0x1a, 0x45, 0xdf, 0xa3 }),
    "Matroska signature matches extension");
var empty = Path.Combine(outDir, "empty.mkv");
using (var writer = new H264RecordingWriter(empty, 64, 48))
    Check(writer.Stop() == null, "empty recording is not reported as saved");
Check(!File.Exists(empty), "empty file removed");
var leading = Path.Combine(outDir, "keyframe-start.mkv");
using (var writer = new H264RecordingWriter(leading, 64, 48))
{
    writer.WriteFrame(frames[1]);
    Check(writer.FrameCount == 0, "leading interframe skipped");
    writer.WriteFrame(frames[0]);
    Check(writer.FrameCount == 1 && writer.Stop() == leading, "first IDR starts a decodable segment");
}
byte[]? sps = null, pps = null;
H264RecordingWriter.ReadParameterSets(frames[0], ref sps, ref pps);
Check(sps != null && pps != null, "codec headers cached independently of recording");
var midstream = Path.Combine(outDir, "midstream-keyframe.mkv");
using (var writer = new H264RecordingWriter(midstream, 64, 48, sps: sps, pps: pps))
{
    var positions = new List<(int Offset, int Type)>();
    var frame = frames[0];
    for (int i = 0; i + 4 < frame.Length; i++)
    {
        int prefix = frame[i] == 0 && frame[i + 1] == 0
            ? frame[i + 2] == 1 ? 3 : frame[i + 2] == 0 && frame[i + 3] == 1 ? 4 : 0 : 0;
        if (prefix == 0) continue;
        positions.Add((i, frame[i + prefix] & 31)); i += prefix - 1;
    }
    positions.Add((frame.Length, 0));
    var withoutHeaders = positions.Zip(positions.Skip(1), (a, b) => (a, b))
        .Where(pair => pair.a.Type is not (7 or 8))
        .SelectMany(pair => frame[pair.a.Offset..pair.b.Offset]).ToArray();
    writer.WriteFrame(withoutHeaders);
    Check(writer.FrameCount == 1 && writer.Stop() == midstream,
        "recording started mid-session can decode an IDR that does not repeat SPS/PPS");
}
var changed = Path.Combine(outDir, "before-config-change.mkv");
using (var writer = new H264RecordingWriter(changed, 64, 48))
{
    writer.WriteFrame(frames[0]);
    bool rejected = false;
    try { writer.WriteFrame(new byte[] { 0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 1, 0x65, 0x88 }); }
    catch (InvalidDataException) { rejected = true; }
    Check(rejected && writer.FrameCount == 1, "changed SPS cannot corrupt an existing track");
    Check(writer.Stop() == changed, "valid prefix can still be finalized");
}
var invalid = Path.Combine(outDir, "invalid.mkv");
using (var writer = new H264RecordingWriter(invalid, 64, 48))
{
    bool rejected = false;
    try { writer.WriteFrame(new byte[] { 1, 2, 3 }); }
    catch (InvalidDataException) { rejected = true; }
    Check(rejected && writer.Stop() == null, "unknown bitstream rejected without a fake recording");
}
var ivf = Path.Combine(outDir, "empty.ivf");
using (var writer = new IvfWriter(ivf, 64, 48))
{
    writer.WriteFrame(new byte[] { 1, 0, 0 });
    Check(writer.FrameCount == 0 && writer.Stop() == null, "VP8 also waits for a keyframe");
}
RejectPartialWrite(new H264RecordingWriter(Path.Combine(outDir, "partial.mkv"), 64, 48), "_stream", frames[0]);
RejectPartialWrite(new IvfWriter(Path.Combine(outDir, "partial.ivf"), 64, 48), "_fs", new byte[] { 0, 1, 2 });
Console.WriteLine("Portable recording-container checks passed. This is NOT a Windows application build or device test.");
static void RejectPartialWrite(IEncodedRecording writer, string fieldName, byte[] frame)
{
    var field = writer.GetType().GetField(fieldName,
        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
    ((FileStream)field.GetValue(writer)!).Dispose();
    field.SetValue(writer, new PartialFailureStream(writer.Path));
    bool failed = false;
    try { writer.WriteFrame(frame); } catch (IOException) { failed = true; }
    Check(failed, "partial I/O failure reaches the recording owner");
    bool refused = false;
    try { writer.Stop(); } catch (IOException) { refused = true; }
    Check(refused, "partially written file is never reported as a successful recording");
}
static void Check(bool condition, string name)
{
    if (!condition) throw new Exception(name);
    Console.WriteLine("PASS " + name);
}

sealed class PartialFailureStream : FileStream
{
    public PartialFailureStream(string path) : base(path, FileMode.Open, FileAccess.Write) { Position = Length; }
    public override void Write(ReadOnlySpan<byte> bytes)
    { base.Write(bytes[..Math.Min(3, bytes.Length)]); throw new IOException("Synthetic partial write"); }
    public override void Write(byte[] bytes, int offset, int count)
    { base.Write(bytes, offset, Math.Min(3, count)); throw new IOException("Synthetic partial write"); }
}

namespace ConnectLive.Admin.Diag
{
    internal static class Log { public static void Warn(string message) => Console.Error.WriteLine(message); }
}
