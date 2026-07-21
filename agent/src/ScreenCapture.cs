using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Very small, dependency-free desktop capture loop.
/// Grabs the primary screen with GDI+ CopyFromScreen, downsamples to
/// max 1280px on the long edge, encodes as JPEG (quality 60) and posts
/// to the gateway ~2 fps. Perfectly transparent — the on-screen
/// SessionIndicator remains visible for the whole duration.
/// </summary>
public static class ScreenCapture
{
    public static async Task RunAsync(ApiClient api, string sessionId, CancellationToken ct)
    {
        var jpeg = ImageCodecInfo.GetImageEncoders();
        ImageCodecInfo? jpegEnc = null;
        foreach (var e in jpeg) if (e.MimeType == "image/jpeg") { jpegEnc = e; break; }
        if (jpegEnc == null) return;

        var encParams = new EncoderParameters(1);
        encParams.Param[0] = new EncoderParameter(Encoder.Quality, 60L);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var bounds = System.Windows.Forms.Screen.PrimaryScreen?.Bounds
                             ?? new Rectangle(0, 0, 1920, 1080);
                using var raw = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(raw))
                    g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);

                // Downsample so payload stays small on slow uplinks.
                int maxEdge = 1280;
                double scale = Math.Min(1.0, (double)maxEdge / Math.Max(raw.Width, raw.Height));
                int w = Math.Max(1, (int)(raw.Width * scale));
                int h = Math.Max(1, (int)(raw.Height * scale));

                using var scaled = new Bitmap(w, h);
                using (var g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                    g.DrawImage(raw, 0, 0, w, h);
                }

                using var ms = new MemoryStream();
                scaled.Save(ms, jpegEnc, encParams);
                await api.PostFrameAsync(sessionId, ms.ToArray(), w, h, ct);
            }
            catch (Exception ex)
            {
                Log.Warn($"capture: {ex.Message}");
            }

            try { await Task.Delay(500, ct); } catch { }
        }
    }
}
