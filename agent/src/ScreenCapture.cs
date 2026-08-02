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
/// Normal profile: max 1920px long edge, JPEG q70 motion / q85 idle.
/// Low-bandwidth profile (auto): 960px, q40 / q55.
/// Reuses bitmap allocations across frames to minimise GC pressure.
/// </summary>
public static class ScreenCapture
{
    // Tunables — Normal (default, sharp) vs low-bandwidth Performance mode.
    private static int _maxEdge = 1920;
    private static long _motionQuality = 70L;
    private static long _idleQuality = 85L;

    /// <summary>True when the low-bandwidth profile is engaged.</summary>
    public static bool PerformanceMode { get; private set; }

    /// <summary>Switch between Normal (1920/q70-85) and Performance (960/q40-55).</summary>
    public static void SetQualityMode(bool performance)
    {
        PerformanceMode = performance;
        if (performance)
        {
            _maxEdge = 960;
            _motionQuality = 40L;
            _idleQuality = 55L;
        }
        else
        {
            _maxEdge = 1920;
            _motionQuality = 70L;
            _idleQuality = 85L;
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
                    // 32bppRgb (no alpha): DXGI hands back B8G8R8A8 surfaces whose
                    // alpha byte is meaningless (often 0) over composited windows.
                    // An ARGB target would alpha-blend those toward black and dim
                    // the whole picture.
                    rawBmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb);
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
                        // SourceCopy: copy the desktop pixels verbatim. The default
                        // SourceOver would blend against the meaningless alpha byte
                        // in the duplication surface and darken the frame.
                        g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                        g.DrawImageUnscaled(dxFrame, 0, 0);
                        haveFreshRaw = true;
                        framesSinceKeyframe = forceRefresh ? 0 : framesSinceKeyframe + 1;
                    }
                    else if (!dxgi.LastFrameHadContentChange)
                    {
                        // Nothing changed on screen — hold last frame, back off.
                        // Still keep the VP8 encoder fed (keepalive) so a static
                        // desktop never freezes the admin's decoded picture.
                        framesSinceKeyframe++;
                        if (scaledBmp != null) TeeToWebRtc(scaledBmp, throttled: true);
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
                    // No alpha channel — see rawBmp above.
                    scaledBmp = new Bitmap(w, h, PixelFormat.Format32bppRgb);
                    prevScaledW = w;
                    prevScaledH = h;
                }

                using (var g = Graphics.FromImage(scaledBmp))
                {
                    // Bicubic only matters when we actually downsample; a 1:1
                    // blit stays on the cheap path.
                    g.InterpolationMode = scale < 1.0
                        ? System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic
                        : System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                    g.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighQuality;
                    // Second guard against alpha blending on the downscale.
                    g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
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
                    // Keepalive push while idle (throttled to IdleTeeIntervalMs).
                    TeeToWebRtc(scaledBmp, throttled: true);
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
                    TeeToWebRtc(scaledBmp, throttled: false);


                    // Use higher quality for idle keyframes, lower for motion frames.
                    var encP = wasIdle ? idleParams : motionParams;
                    using var ms = new MemoryStream();
                    scaledBmp.Save(ms, jpegEnc, encP);
                    var uploadSw = System.Diagnostics.Stopwatch.StartNew();
                    bool posted = await api.PostFrameAsync(sessionId, ms.ToArray(), w, h, ct);
                    uploadSw.Stop();
                    NoteUploadLatency(uploadSw.ElapsedMilliseconds);
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

        // Cleanup reusable bitmaps + DXGI resources.
        rawBmp?.Dispose();
        scaledBmp?.Dispose();
        dxgi?.Dispose();
    }

    // ---- WebRTC tee ------------------------------------------------------
    // Copies the scaled frame into the VP8 track. `throttled` only applies to
    // genuinely-unchanged frames (keepalive so the decoder never staleness-
    // smears); changed frames always go through at full capture rate.
    private const int IdleTeeIntervalMs = 200;
    private static DateTime _lastTeeUtc = DateTime.MinValue;

    /// <summary>
    /// Clears the idle-throttle clock so a freshly-built (or freshly-started)
    /// peer receives the very next captured frame instead of waiting out the
    /// remainder of the keepalive window.
    /// </summary>
    public static void ResetWebRtcTee() => _lastTeeUtc = DateTime.MinValue;



    private static void TeeToWebRtc(Bitmap scaled, bool throttled)
    {
        try
        {
            var live = WebRtcSession.Current;
            if (live == null) return;
            var now = DateTime.UtcNow;
            if (throttled && (now - _lastTeeUtc).TotalMilliseconds < IdleTeeIntervalMs) return;
            _lastTeeUtc = now;

            int w = scaled.Width, h = scaled.Height;
            var rect = new Rectangle(0, 0, w, h);
            var data = scaled.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                // Pack tightly (width*4 per row, no stride padding) so the encoder
                // never sees the GDI alignment slack — that padding is what shears
                // frames on non-multiple-of-4 widths (e.g. 960px low-BW profile
                // after downscale rounding).
                int rowBytes = w * 4;
                var buf = new byte[rowBytes * h];
                IntPtr src = data.Scan0;
                unsafe
                {
                    byte* sp = (byte*)src.ToPointer();
                    fixed (byte* dpFixed = buf)
                    {
                        byte* dp = dpFixed;
                        for (int y = 0; y < h; y++)
                        {
                            byte* srow = sp + y * data.Stride;
                            byte* drow = dp + y * rowBytes;
                            // GDI Format32bppRgb memory order is B,G,R,X — exactly
                            // what VideoPixelFormatsEnum.Bgra expects, and exactly
                            // what the JPEG encoder reads. Copy verbatim; the only
                            // fix-up is forcing the undefined 4th byte opaque.
                            Buffer.MemoryCopy(srow, drow, rowBytes, rowBytes);
                            for (int x = 3; x < rowBytes; x += 4) drow[x] = 0xFF;
                        }
                    }
                }
                live.PushFrame(buf, w, h);
            }
            finally { scaled.UnlockBits(data); }
        }
        catch (Exception ex) { Log.Warn($"webrtc tee: {ex.Message}"); }
    }



    // ---- Adaptive quality ------------------------------------------------
    // Downgrade to the low-bandwidth profile after 5 consecutive frames whose
    // upload took > 400 ms; upgrade back after a continuous 30 s window with
    // every upload under 150 ms.
    private static int _slowStreak;
    private static DateTime _fastSince = DateTime.MinValue;

    private static void NoteUploadLatency(long ms)
    {
        if (!PerformanceMode)
        {
            _fastSince = DateTime.MinValue;
            if (ms > 400)
            {
                if (++_slowStreak >= 5)
                {
                    _slowStreak = 0;
                    SetQualityMode(true);
                    Log.Info("live view: link slow — switching to low-bandwidth profile (960px)");
                }
            }
            else _slowStreak = 0;
        }
        else
        {
            _slowStreak = 0;
            if (ms < 150)
            {
                if (_fastSince == DateTime.MinValue) _fastSince = DateTime.UtcNow;
                else if ((DateTime.UtcNow - _fastSince).TotalSeconds >= 30)
                {
                    _fastSince = DateTime.MinValue;
                    SetQualityMode(false);
                    Log.Info("live view: link healthy — restoring sharp profile (1920px)");
                }
            }
            else _fastSince = DateTime.MinValue;
        }
    }

    private static ulong HashBitmap(Bitmap bmp)
    {
        var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
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
