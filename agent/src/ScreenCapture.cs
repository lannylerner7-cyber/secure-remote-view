using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Desktop capture loop. Adaptive cadence: targets ~30 FPS (33ms) during
/// motion, backs off to ~10 FPS (100ms) when the screen is static.
/// Downsamples to max 960px long edge, JPEG q40 during motion / q55 idle.
/// Reuses bitmap allocations across frames to minimise GC pressure.
/// </summary>
public static class ScreenCapture
{
    // Tunables — Performance mode (default) vs Normal mode.
    private static int _maxEdge = 960;
    private static long _motionQuality = 40L;
    private static long _idleQuality = 55L;

    /// <summary>Switch between Normal (1280/q55) and Performance (960/q40) modes.</summary>
    public static void SetQualityMode(bool performance)
    {
        if (performance)
        {
            _maxEdge = 960;
            _motionQuality = 40L;
            _idleQuality = 55L;
        }
        else
        {
            _maxEdge = 1280;
            _motionQuality = 55L;
            _idleQuality = 55L;
        }
    }

    public static async Task RunAsync(ApiClient api, string sessionId, CancellationToken ct)
    {
        var codecs = ImageCodecInfo.GetImageEncoders();
        ImageCodecInfo? jpegEnc = null;
        foreach (var e in codecs) if (e.MimeType == "image/jpeg") { jpegEnc = e; break; }
        if (jpegEnc == null) return;

        var motionParams = new EncoderParameters(1);
        motionParams.Param[0] = new EncoderParameter(Encoder.Quality, _motionQuality);

        var idleParams = new EncoderParameters(1);
        idleParams.Param[0] = new EncoderParameter(Encoder.Quality, _idleQuality);

        ulong lastHash = 0;
        int idleCount = 0;
        int uploadFails = 0;
        int framesSinceKeyframe = 0;

        // Reusable bitmaps — only reallocated when screen bounds change.
        Bitmap? rawBmp = null;
        Bitmap? scaledBmp = null;
        int prevBoundsW = 0, prevBoundsH = 0;
        int prevScaledW = 0, prevScaledH = 0;

        // Try DXGI Desktop Duplication once — falls back to GDI transparently
        // on RDP, Session 0, or any COM failure. Enterprise pipeline: ~sub-ms
        // GPU acquire vs 15-30ms CPU BitBlt.
        DxgiCapture? dxgi = new DxgiCapture();
        if (!dxgi.TryInitialize())
        {
            dxgi.Dispose();
            dxgi = null;
            Log.Info("capture: DXGI unavailable, using GDI fallback");
        }

        while (!ct.IsCancellationRequested)
        {
            int delayMs = 33; // ~30 FPS target during motion
            try
            {
                var bounds = System.Windows.Forms.Screen.PrimaryScreen?.Bounds
                             ?? new Rectangle(0, 0, 1920, 1080);

                // Reallocate raw bitmap only when screen size changes.
                if (rawBmp == null || bounds.Width != prevBoundsW || bounds.Height != prevBoundsH)
                {
                    rawBmp?.Dispose();
                    rawBmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
                    prevBoundsW = bounds.Width;
                    prevBoundsH = bounds.Height;
                }

                // DXGI path: acquire from GPU. When it returns null AND the
                // last frame reported no change, skip the whole encode cycle.
                bool haveFreshRaw = false;
                if (dxgi != null && dxgi.IsInitialized)
                {
                    // Force a full refresh every ~60 frames (~2s at 30fps) so
                    // fresh admin subscribers see the current desktop.
                    bool forceRefresh = framesSinceKeyframe >= 60;
                    using var dxFrame = dxgi.TryCapture(15, forceRefresh);
                    if (dxFrame != null)
                    {
                        using var g = Graphics.FromImage(rawBmp);
                        g.DrawImageUnscaled(dxFrame, 0, 0);
                        haveFreshRaw = true;
                        framesSinceKeyframe = forceRefresh ? 0 : framesSinceKeyframe + 1;
                    }
                    else if (!dxgi.LastFrameHadContentChange)
                    {
                        // Nothing changed on screen — hold last frame, back off.
                        framesSinceKeyframe++;
                        try { await Task.Delay(100, ct); } catch { }
                        continue;
                    }
                }

                if (!haveFreshRaw)
                {
                    using var g = Graphics.FromImage(rawBmp);
                    g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
                    framesSinceKeyframe++;
                }


                int maxEdge = _maxEdge;
                double scale = Math.Min(1.0, (double)maxEdge / Math.Max(rawBmp.Width, rawBmp.Height));
                int w = Math.Max(1, (int)(rawBmp.Width * scale));
                int h = Math.Max(1, (int)(rawBmp.Height * scale));

                // Reallocate scaled bitmap only when target size changes.
                if (scaledBmp == null || w != prevScaledW || h != prevScaledH)
                {
                    scaledBmp?.Dispose();
                    scaledBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                    prevScaledW = w;
                    prevScaledH = h;
                }

                using (var g = Graphics.FromImage(scaledBmp))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                    g.DrawImage(rawBmp, 0, 0, w, h);
                }

                // Fast dirty-frame detection: FNV-1a over strided pixel samples.
                ulong hash = HashBitmap(scaledBmp);
                bool unchanged = hash == lastHash;

                // Adaptive idle backoff: after 3+ unchanged frames, slow to 100ms.
                // Force a keyframe every ~2s even when idle so a fresh admin
                // subscriber still sees the current screen.
                if (unchanged && idleCount < 20)
                {
                    idleCount++;
                    delayMs = idleCount >= 3 ? 100 : 33;
                }
                else
                {
                    bool wasIdle = idleCount >= 3;
                    idleCount = 0;
                    lastHash = hash;
                    delayMs = 33; // back to full speed

                    // Update quality params if the mode changed at runtime.
                    motionParams.Param[0] = new EncoderParameter(Encoder.Quality, _motionQuality);
                    idleParams.Param[0] = new EncoderParameter(Encoder.Quality, _idleQuality);

                    // Tee the frame into the WebRTC track when a peer is connected.
                    try
                    {
                        var live = WebRtcSession.Current;
                        if (live != null)
                        {
                            var rect = new Rectangle(0, 0, scaledBmp.Width, scaledBmp.Height);
                            var data = scaledBmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                            try
                            {
                                var buf = new byte[data.Stride * data.Height];
                                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                                live.PushFrame(buf, data.Width, data.Height, data.Stride);
                            }
                            finally { scaledBmp.UnlockBits(data); }
                        }
                    }
                    catch (Exception ex) { Log.Warn($"webrtc tee: {ex.Message}"); }

                    // Use higher quality for idle keyframes, lower for motion frames.
                    var encP = wasIdle ? idleParams : motionParams;
                    using var ms = new MemoryStream();
                    scaledBmp.Save(ms, jpegEnc, encP);
                    bool posted = await api.PostFrameAsync(sessionId, ms.ToArray(), w, h, ct);
                    if (posted)
                    {
                        if (uploadFails > 0) Log.Info($"frame upload recovered after {uploadFails} failure(s)");
                        uploadFails = 0;
                    }
                    else
                    {
                        uploadFails++;
                        if (uploadFails == 1 || uploadFails % 10 == 0)
                            Log.Warn($"frame upload failed ({uploadFails}) for session {sessionId}");
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn($"capture: {ex.Message}");
            }

            try { await Task.Delay(delayMs, ct); } catch { }
        }

        // Cleanup reusable bitmaps.
        rawBmp?.Dispose();
        scaledBmp?.Dispose();
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
}
