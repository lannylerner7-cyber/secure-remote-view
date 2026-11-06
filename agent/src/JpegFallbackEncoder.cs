using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace ConnectLive.Agent;

/// <summary>
/// Readable desktop fallback, independent of the software-video resolution ladder.
/// Never upscales. The binary cap keeps base64 below the frame API's 2 MB limit.
/// </summary>
internal static class JpegFallbackEncoder
{
    internal const int MaxEdge = 3840;
    internal const int MaxPixels = 3840 * 2160;
    internal const int MaxBytes = 1_450_000;
    internal const int MotionIntervalMs = 500;
    internal const long MotionQuality = 86;
    internal const long IdleQuality = 94;

    internal static (byte[] Bytes, int Width, int Height) Encode(Bitmap source, bool idle)
    {
        var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), e => e.MimeType == "image/jpeg")
            ?? throw new InvalidOperationException("JPEG encoder unavailable.");
        double scale = Math.Min(1.0, Math.Min(
            (double)MaxEdge / Math.Max(source.Width, source.Height),
            Math.Sqrt((double)MaxPixels / ((long)source.Width * source.Height))));

        // Prefer cadence over blur. Only oversized payloads lower quality/size.
        for (int attempt = 0; attempt < 6; attempt++)
        {
            int width = Math.Max(1, (int)(source.Width * scale));
            int height = Math.Max(1, (int)(source.Height * scale));
            using var resized = width == source.Width && height == source.Height
                ? null : new Bitmap(width, height, PixelFormat.Format32bppRgb);
            if (resized != null)
            {
                using var g = Graphics.FromImage(resized);
                g.CompositingMode = CompositingMode.SourceCopy;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, 0, 0, width, height);
            }
            foreach (long quality in new[] { idle ? IdleQuality : MotionQuality, 80L })
            {
                using var parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
                using var stream = new MemoryStream();
                (resized ?? source).Save(stream, codec, parameters);
                if (stream.Length <= MaxBytes) return (stream.ToArray(), width, height);
            }
            scale *= 0.75;
        }
        throw new InvalidOperationException("JPEG could not fit the frame upload limit.");
    }
}
