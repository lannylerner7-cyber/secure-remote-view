using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using ConnectLive.Admin.Media;
using SIPSorceryMedia.Abstractions;
using SIPSorceryMedia.Encoders;

// =====================================================================
// Spike 1 — VP8 decodes with correct colour (Gate B)
//
//   capture.rtpdump  ->  depacketize  ->  VP8 decode  ->  BGRA  ->  PNG
//
// Fully offline. Touches no network, no session, no UI. The live JPEG
// path is undisturbed while the operator records the dump.
//
//   dotnet run --project admin/spikes/vp8-decode -- [path-to-capture.rtpdump]
//
// Gate is green when:
//   * >= 1 keyframe decodes,
//   * 5 PNGs land in ./out,
//   * the orange card in frame reads back as orange (H ~20-45 deg,
//     R > G > B) — printed per frame as ORANGE-CHECK.
// =====================================================================

internal static class Program
{
    private const int WantPngs = 5;

    private static int Main(string[] args)
    {
        var path = args.Length > 0
            ? args[0]
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ConnectLive", "spikes", "vp8-decode", "capture.rtpdump");

        if (!File.Exists(path))
        {
            Console.Error.WriteLine($"no capture at {path}");
            Console.Error.WriteLine("record one:  setx CONNECTLIVE_RTP_CAPTURE 1  then run a session for ~10s of motion.");
            return 2;
        }

        var outDir = Path.Combine(AppContext.BaseDirectory, "out");
        Directory.CreateDirectory(outDir);

        var packets = ReadDump(path).ToList();
        Console.WriteLine($"[spike1] {packets.Count} RTP packets from {path}");
        if (packets.Count == 0) return 2;

        var frames = Depacketize(packets).ToList();
        Console.WriteLine($"[spike1] {frames.Count} VP8 frames reassembled " +
                          $"({frames.Count(f => f.KeyFrame)} keyframes)");
        if (frames.Count == 0) { Console.Error.WriteLine("[spike1] FAIL — no complete frames"); return 1; }

        using var decoder = new VpxVideoEncoder();
        int written = 0, decoded = 0, orangeOk = 0;

        foreach (var f in frames)
        {
            IEnumerable<VideoSample>? samples;
            try { samples = decoder.DecodeVideo(f.Payload, VideoPixelFormatsEnum.Bgra, VideoCodecsEnum.VP8); }
            catch (Exception ex) { Console.WriteLine($"[spike1] decode error: {ex.Message}"); continue; }
            if (samples == null) continue;

            foreach (var s in samples)
            {
                int w = (int)s.Width, h = (int)s.Height;
                if (w <= 0 || h <= 0 || s.Sample == null) continue;
                decoded++;

                var shape = FrameConvert.Classify(s.Sample.Length, w, h);
                var bgra = new byte[w * h * 4];
                if (!FrameConvert.ToBgra32(s.Sample, w, h, bgra))
                {
                    Console.WriteLine($"[spike1] unrecognised sample: {s.Sample.Length} bytes for {w}x{h}");
                    continue;
                }

                if (written < WantPngs)
                {
                    var file = Path.Combine(outDir, $"frame{written:D2}_{w}x{h}.png");
                    WritePng(bgra, w, h, file);
                    var check = OrangeCheck(bgra, w, h);
                    if (check.orange) orangeOk++;
                    Console.WriteLine($"[spike1] {Path.GetFileName(file)} shape={shape} " +
                                      $"dominant=rgb({check.r},{check.g},{check.b}) hue={check.hue:F0}deg " +
                                      $"ORANGE-CHECK={(check.orange ? "PASS" : "no-orange-region")}");
                    written++;
                }
            }
            if (written >= WantPngs) break;
        }

        Console.WriteLine($"[spike1] decoded={decoded} pngs={written} orangeFrames={orangeOk} out={outDir}");
        if (decoded == 0) { Console.Error.WriteLine("[spike1] GATE B FAIL — nothing decoded"); return 1; }
        Console.WriteLine("[spike1] GATE B: decode OK. Open the PNGs and confirm the image is coherent " +
                          "(no diagonal shear, no red/blue swap) before declaring green.");
        return 0;
    }

    // ---- dump reader: [int64 arrivalMs][int32 len][len bytes] -----------

    private static IEnumerable<byte[]> ReadDump(string path)
    {
        using var fs = File.OpenRead(path);
        using var br = new BinaryReader(fs);
        while (fs.Position + 12 <= fs.Length)
        {
            br.ReadInt64();
            int len = br.ReadInt32();
            if (len <= 0 || fs.Position + len > fs.Length) yield break;
            yield return br.ReadBytes(len);
        }
    }

    // ---- RTP + VP8 payload descriptor ----------------------------------

    private readonly record struct Frame(byte[] Payload, bool KeyFrame, uint Timestamp);

    private static IEnumerable<Frame> Depacketize(List<byte[]> packets)
    {
        var buf = new MemoryStream();
        uint current = 0;
        bool started = false, key = false;

        foreach (var pkt in packets)
        {
            if (pkt.Length < 12 || (pkt[0] >> 6) != 2) continue;      // RTP v2 only
            int csrc = pkt[0] & 0x0F;
            bool ext = (pkt[0] & 0x10) != 0;
            bool marker = (pkt[1] & 0x80) != 0;
            uint ts = (uint)((pkt[4] << 24) | (pkt[5] << 16) | (pkt[6] << 8) | pkt[7]);

            int off = 12 + csrc * 4;
            if (ext)
            {
                if (off + 4 > pkt.Length) continue;
                int words = (pkt[off + 2] << 8) | pkt[off + 3];
                off += 4 + words * 4;
            }
            if (off >= pkt.Length) continue;

            // VP8 payload descriptor (RFC 7741 §4.2)
            int p = off;
            byte d0 = pkt[p++];
            bool X = (d0 & 0x80) != 0;
            bool S = (d0 & 0x10) != 0;              // start of partition
            int pid = d0 & 0x07;
            if (X)
            {
                if (p >= pkt.Length) continue;
                byte d1 = pkt[p++];
                bool I = (d1 & 0x80) != 0, L = (d1 & 0x40) != 0,
                     T = (d1 & 0x20) != 0, K = (d1 & 0x10) != 0;
                if (I)
                {
                    if (p >= pkt.Length) continue;
                    bool longPid = (pkt[p] & 0x80) != 0;
                    p += longPid ? 2 : 1;
                }
                if (L) p++;
                if (T || K) p++;
            }
            if (p >= pkt.Length) continue;

            bool frameStart = S && pid == 0;
            if (frameStart)
            {
                if (started && buf.Length > 0) yield return new Frame(buf.ToArray(), key, current);
                buf.SetLength(0);
                started = true;
                current = ts;
                key = (pkt[p] & 0x01) == 0;         // VP8 payload header P bit: 0 = keyframe
            }
            if (!started) continue;

            buf.Write(pkt, p, pkt.Length - p);

            if (marker)
            {
                if (buf.Length > 0) yield return new Frame(buf.ToArray(), key, current);
                buf.SetLength(0);
                started = false;
            }
        }
        if (started && buf.Length > 0) yield return new Frame(buf.ToArray(), key, current);
    }

    // ---- output + colour proof ------------------------------------------

    private static void WritePng(byte[] bgra, int w, int h, string file)
    {
        var bmp = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, bgra, w * 4);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(bmp));
        using var fs = File.Create(file);
        enc.Save(fs);
    }

    /// <summary>
    /// The colour gate: find the most saturated region average and report its
    /// hue. A BT.709/full-range mix-up drags orange (~30 deg) toward red-brown
    /// (&lt;15 deg), and an R/B swap throws it past 200 deg — both fail loudly.
    /// </summary>
    private static (int r, int g, int b, double hue, bool orange) OrangeCheck(byte[] bgra, int w, int h)
    {
        long sr = 0, sg = 0, sb = 0, n = 0;
        for (int y = 0; y < h; y += 2)
        {
            int row = y * w * 4;
            for (int x = 0; x < w; x += 2)
            {
                int i = row + x * 4;
                int b = bgra[i], g = bgra[i + 1], r = bgra[i + 2];
                int max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b));
                if (max - min < 60) continue;                 // ignore grey desktop chrome
                if (r <= g || g < b) continue;                // orange family: R > G > B
                sr += r; sg += g; sb += b; n++;
            }
        }
        if (n == 0) return (0, 0, 0, -1, false);
        int ar = (int)(sr / n), ag = (int)(sg / n), ab = (int)(sb / n);
        double hue = Hue(ar, ag, ab);
        return (ar, ag, ab, hue, hue >= 15 && hue <= 50);
    }

    private static double Hue(int r, int g, int b)
    {
        double rf = r / 255.0, gf = g / 255.0, bf = b / 255.0;
        double max = Math.Max(rf, Math.Max(gf, bf)), min = Math.Min(rf, Math.Min(gf, bf));
        double d = max - min;
        if (d <= 0) return 0;
        double hue = max == rf ? 60 * (((gf - bf) / d) % 6)
                   : max == gf ? 60 * (((bf - rf) / d) + 2)
                               : 60 * (((rf - gf) / d) + 4);
        return hue < 0 ? hue + 360 : hue;
    }
}
