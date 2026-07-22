using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Desktop capture loop. Runs at ~7fps (140ms) and cheaply skips upload
/// when the screen hasn't visibly changed (fast strided FNV-1a hash on the
/// scaled RGB buffer). Downsamples to max 1280px long edge, JPEG q55.
/// </summary>
public static class ScreenCapture
{
    private const uint CURSOR_SHOWING = 0x00000001;
    private const int DI_NORMAL = 0x0003;

    public static async Task RunAsync(ApiClient api, string sessionId, CancellationToken ct)
    {
        var encoders = ImageCodecInfo.GetImageEncoders();
        ImageCodecInfo? jpegEnc = null;
        foreach (var e in encoders) if (e.MimeType == "image/jpeg") { jpegEnc = e; break; }
        if (jpegEnc == null) return;

        var encParams = new EncoderParameters(1);
        encParams.Param[0] = new EncoderParameter(Encoder.Quality, 55L);

        ulong lastHash = 0;
        int idleCount = 0;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var bounds = System.Windows.Forms.Screen.PrimaryScreen?.Bounds
                             ?? new Rectangle(0, 0, 1920, 1080);
                using var raw = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(raw))
                {
                    // NOTE: cursor is intentionally NOT burned into the frame.
                    // CursorPump streams x/y + kind at ~30Hz on a side channel
                    // and the admin renders an SVG overlay — decouples pointer
                    // smoothness from JPEG frame cadence (Phase 1 upgrade).
                    g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
                }

                int maxEdge = 1280;
                double scale = Math.Min(1.0, (double)maxEdge / Math.Max(raw.Width, raw.Height));
                int w = Math.Max(1, (int)(raw.Width * scale));
                int h = Math.Max(1, (int)(raw.Height * scale));

                using var scaled = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                    g.DrawImage(raw, 0, 0, w, h);
                }

                // Fast dirty-frame detection: FNV-1a over strided pixel samples.
                // Cursor motion no longer forces a frame — CursorPump handles it.
                ulong hash = HashBitmap(scaled);
                bool unchanged = hash == lastHash;
                // Force a keyframe every ~2s even when idle, so a fresh admin
                // subscriber still sees the current screen.
                if (unchanged && idleCount < 12) { idleCount++; }
                else
                {
                    idleCount = 0;
                    lastHash = hash;
                    // Tee the frame into the WebRTC track when a peer is connected;
                    // silently no-ops otherwise (HTTPS stream keeps flowing).
                    try
                    {
                        var live = WebRtcSession.Current;
                        if (live != null)
                        {
                            var rect = new Rectangle(0, 0, scaled.Width, scaled.Height);
                            var data = scaled.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                            try
                            {
                                var buf = new byte[data.Stride * data.Height];
                                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                                live.PushFrame(buf, data.Width, data.Height, data.Stride);
                            }
                            finally { scaled.UnlockBits(data); }
                        }
                    }
                    catch (Exception ex) { Log.Warn($"webrtc tee: {ex.Message}"); }

                    using var ms = new MemoryStream();
                    scaled.Save(ms, jpegEnc, encParams);
                    await api.PostFrameAsync(sessionId, ms.ToArray(), w, h, ct);
                }
            }
            catch (Exception ex)
            {
                Log.Warn($"capture: {ex.Message}");
            }

            try { await Task.Delay(140, ct); } catch { }
        }
    }

    private static ulong HashBitmap(Bitmap bmp)
    {
        var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int total = data.Stride * bmp.Height;
            int step = Math.Max(64, total / 4096); // ~4k samples
            ulong hash = 1469598103934665603UL; // FNV-1a offset
            IntPtr ptr = data.Scan0;
            var buf = new byte[Math.Min(total, 8)];
            for (int i = 0; i < total; i += step)
            {
                Marshal.Copy(IntPtr.Add(ptr, i), buf, 0, buf.Length);
                for (int k = 0; k < buf.Length; k++)
                {
                    hash ^= buf[k];
                    hash *= 1099511628211UL;
                }
            }
            return hash;
        }
        finally { bmp.UnlockBits(data); }
    }

    // NOTE: cursor rendering intentionally removed. Cursor position and kind
    // are now streamed separately by CursorPump; the admin overlays an SVG
    // pointer on top of the frame for jitter-free motion. See Phase-1 notes
    // in INSTALL.md.
}

