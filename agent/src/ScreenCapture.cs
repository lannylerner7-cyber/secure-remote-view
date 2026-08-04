using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Desktop capture loop. Adaptive cadence: targets the current ladder rung's
/// FPS during motion, backs off to ~10 FPS when the screen is static.
///
/// SCOPE:TRANSPORT — resolution, JPEG quality and frame cadence are NOT owned
/// here any more. <see cref="BitrateController"/> owns the
/// (targetBitrate, maxEdge, fps) triple and is driven by RTCP receiver reports
/// on the WebRTC path plus HTTPS upload latency on the fallback path. This
/// loop simply reads <see cref="BitrateController.Current"/> every frame, so a
/// rung change takes effect on the very next capture with no restart.
/// Reuses bitmap allocations across frames to minimise GC pressure.
/// </summary>
public static class ScreenCapture
{
    /// <summary>
    /// True when the ladder has dropped below the sharp rungs. S17 — the
    /// threshold moved with the two prepended 4K/2K rungs; index 5 is the
    /// 1024px rung this used to mean when it read 3.
    /// </summary>
    public static bool PerformanceMode => BitrateController.RungIndex >= 5;


    /// <summary>
    /// Longest edge, in pixels, of the frame currently being shipped.
    /// <see cref="CursorPump"/> reads this so cursor telemetry lands in the
    /// exact coordinate space of the picture the technician is looking at.
    /// </summary>
    public static int MaxEdge => BitrateController.Current.MaxEdge;

    /// <summary>
    /// Periodic full refresh, in frames, used as a *safety net* only.
    /// Keyframes are normally driven on demand by RTCP PLI/FIR
    /// (<see cref="WebRtcSession"/>). Before that handler existed this was 60
    /// (~2 s) because it was the only recovery path after packet loss; with
    /// real feedback wired up it can relax to ~10 s, which removes a periodic
    /// bandwidth spike that bought nothing on a healthy link.
    /// </summary>
    private const int PeriodicRefreshFrames = 300;

    static ScreenCapture()
    {
        // A rung change alters the encoder's frame size; the admin's decoder
        // must be handed a fresh picture rather than a delta against a frame
        // of the previous dimensions.
        BitrateController.Changed += _ =>
        {
            _logNextTee = true;
            ResetWebRtcTee();
        };
    }

    /// <summary>Legacy two-state switch; now pins a ladder rung.</summary>
    public static void SetQualityMode(bool performance) => BitrateController.Pin(performance);



    public static async Task RunAsync(ApiClient api, string sessionId, CancellationToken ct)
    {
        var codecs = ImageCodecInfo.GetImageEncoders();
        ImageCodecInfo? jpegEnc = null;
        foreach (var e in codecs) if (e.MimeType == "image/jpeg") { jpegEnc = e; break; }
        if (jpegEnc == null) return;

        var motionParams = new EncoderParameters(1);
        motionParams.Param[0] = new EncoderParameter(Encoder.Quality, BitrateController.Current.MotionQuality);

        var idleParams = new EncoderParameters(1);
        idleParams.Param[0] = new EncoderParameter(Encoder.Quality, BitrateController.Current.IdleQuality);


        ulong lastHash = 0;
        int idleCount = 0;
        int uploadFails = 0;
        int framesSinceKeyframe = 0;

        // Reusable bitmaps — only reallocated when screen bounds change.
        Bitmap? rawBmp = null;
        Bitmap? scaledBmp = null;
        // S17 — the frame actually shipped last iteration. With the 1:1
        // passthrough this is rawBmp on a native-resolution rung and scaledBmp
        // otherwise, so the idle keepalive can no longer assume scaledBmp.
        Bitmap? lastFrame = null;
        int prevBoundsW = 0, prevBoundsH = 0;
        int prevScaledW = 0, prevScaledH = 0;

        // Try DXGI Desktop Duplication once — falls back to GDI transparently
        // on RDP, Session 0, or any COM failure. Enterprise pipeline: ~sub-ms
        // GPU acquire vs 15-30ms CPU BitBlt. The output it duplicates is the
        // one MonitorSelector points at, not blindly index 0.
        DxgiCapture? dxgi = new DxgiCapture();
        if (!dxgi.TryInitialize())
        {
            dxgi.Dispose();
            dxgi = null;
            Log.Info("capture: DXGI unavailable, using GDI fallback");
        }

        // Remember which display we are on so a picker change (or a monitor
        // being unplugged) reallocates the bitmaps instead of blitting a
        // 2560-wide desktop into a 1920-wide buffer.
        string lastDeviceName = MonitorSelector.SelectedDeviceName;
        // GDI-fallback rebuild clock, mirrors the DXGI reinit rate limit.
        var lastDxgiRetryUtc = DateTime.UtcNow;

        while (!ct.IsCancellationRequested)
        {
            // Read the ladder once per frame: rung changes land on the very
            // next capture without restarting the loop.
            var rung = BitrateController.Current;
            int motionDelayMs = rung.FrameDelayMs;
            int delayMs = motionDelayMs;
            try
            {
                var target = MonitorSelector.Resolve();
                var bounds = target.Bounds;
                if (bounds.Width <= 0 || bounds.Height <= 0)
                {
                    // S17 — never invent 1920x1080. On a 4K box that hardcoded
                    // fallback silently capped the whole session at 1080p and
                    // then blamed the ladder. Ask Windows for the real virtual
                    // desktop; only if THAT is unusable do we guess, and the
                    // guess is logged so it can never hide again.
                    var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
                    if (vs.Width > 0 && vs.Height > 0)
                    {
                        bounds = vs;
                    }
                    else
                    {
                        bounds = new Rectangle(0, 0, 1920, 1080);
                        Log.Warn("capture: no usable monitor bounds; falling back to 1920x1080");
                    }
                }


                if (!string.Equals(lastDeviceName, target.DeviceName, StringComparison.OrdinalIgnoreCase))
                {
                    Log.Info($"capture: monitor switched {lastDeviceName} -> {target.DeviceName}");
                    lastDeviceName = target.DeviceName;
                    // Force a re-scale/re-alloc on the next block and re-tee so
                    // the admin sees the new display within one frame interval.
                    prevBoundsW = prevBoundsH = 0;
                    ResetWebRtcTee();
                }

                // GDI fallback is running but DXGI may have become available
                // again (RDP session ended, secure desktop dismissed, driver
                // recovered). Retry at most once every 10 s.
                if (dxgi == null && (DateTime.UtcNow - lastDxgiRetryUtc).TotalSeconds >= 10)
                {
                    lastDxgiRetryUtc = DateTime.UtcNow;
                    var probe = new DxgiCapture();
                    if (probe.TryInitialize())
                    {
                        dxgi = probe;
                        Log.Info($"capture: DXGI became available on {probe.DeviceName}");
                    }
                    else probe.Dispose();
                }

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
                    // An RTCP-driven keyframe just went out: restart the
                    // countdown from it rather than emitting a second one.
                    if (ConsumeKeyframeClockReset()) framesSinceKeyframe = 0;

                    // Safety-net full refresh (see PeriodicRefreshFrames). The
                    // real recovery path is the RTCP PLI/FIR handler in
                    // WebRtcSession, which forces a keyframe on actual loss.
                    bool forceRefresh = framesSinceKeyframe >= PeriodicRefreshFrames;

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
                        if (lastFrame != null) TeeToWebRtc(lastFrame, throttled: true);
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


                int maxEdge = rung.MaxEdge;
                double scale = Math.Min(1.0, (double)maxEdge / Math.Max(rawBmp.Width, rawBmp.Height));
                // VP8 uses I420 2x2 chroma blocks. Keep both dimensions even;
                // odd scaled heights (for example 539) shift the chroma planes.
                int w = Math.Max(2, (int)(rawBmp.Width * scale) & ~1);
                int h = Math.Max(2, (int)(rawBmp.Height * scale) & ~1);

                // S17 — TRUE 1:1 PASSTHROUGH.
                //
                // When the rung's max edge is at or above the desktop size the
                // old code still allocated a second full-size bitmap and blitted
                // the whole desktop into it every frame — at 3840x2160 that is a
                // ~33 MB copy per frame, 30 times a second, for a picture that is
                // pixel-identical to the source. Worse, a NearestNeighbor
                // DrawImage at 1:1 is not guaranteed to be bit-exact, so it also
                // cost sharpness it had no right to cost.
                //
                // Skip it entirely. The only reason we would still need the copy
                // at scale >= 1.0 is an odd desktop dimension (rare, but real on
                // some scaled laptop panels), because the encoder needs even
                // dimensions — that case falls through to the resample path with
                // w/h rounded down to even.
                bool oneToOne = scale >= 1.0 && w == rawBmp.Width && h == rawBmp.Height;
                Bitmap frame;
                if (oneToOne)
                {
                    frame = rawBmp;
                    // Release the scratch buffer: on a 4K desktop it is 33 MB of
                    // large-object-heap that will never be read again.
                    if (scaledBmp != null)
                    {
                        scaledBmp.Dispose();
                        scaledBmp = null;
                        prevScaledW = prevScaledH = 0;
                    }
                }
                else
                {
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
                        // Bicubic only matters when we actually downsample.
                        g.InterpolationMode = scale < 1.0
                            ? System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic
                            : System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                        g.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighQuality;
                        // Second guard against alpha blending on the downscale.
                        g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                        g.DrawImage(rawBmp, 0, 0, w, h);
                    }
                    frame = scaledBmp;
                }

                // The frame the idle keepalive re-sends when nothing changed.
                lastFrame = frame;


                // Fast dirty-frame detection: FNV-1a over strided pixel samples.
                ulong hash = HashBitmap(frame);
                bool unchanged = hash == lastHash;

                // Adaptive idle backoff: after 3+ unchanged frames, slow to 100ms.
                // Force a keyframe every ~2s even when idle so a fresh admin
                // subscriber still sees the current screen.
                if (unchanged && idleCount < 20)
                {
                    idleCount++;
                    delayMs = idleCount >= 3 ? 100 : motionDelayMs;
                    // Keepalive push while idle (throttled to IdleTeeIntervalMs).
                    TeeToWebRtc(frame, throttled: true);
                }
                else
                {
                    bool wasIdle = idleCount >= 3;
                    idleCount = 0;
                    lastHash = hash;
                    delayMs = motionDelayMs; // back to the rung's full rate

                    // Update quality params if the mode changed at runtime.
                    motionParams.Param[0] = new EncoderParameter(Encoder.Quality, rung.MotionQuality);
                    idleParams.Param[0] = new EncoderParameter(Encoder.Quality, rung.IdleQuality);

                    // Tee the frame into the WebRTC track when a peer is connected.
                    TeeToWebRtc(frame, throttled: false);


                    // Use higher quality for idle keyframes, lower for motion frames.
                    var encP = wasIdle ? idleParams : motionParams;
                    using var ms = new MemoryStream();
                    frame.Save(ms, jpegEnc, encP);
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
    /// <summary>Step 1 diagnostics: log the first tee after a resolution/profile change.</summary>
    private static bool _logNextTee = false;

    /// <summary>
    /// Clears the idle-throttle clock so a freshly-built (or freshly-started)
    /// peer receives the very next captured frame instead of waiting out the
    /// remainder of the keepalive window.
    /// </summary>
    public static void ResetWebRtcTee()
    {
        _lastTeeUtc = DateTime.MinValue;
        _logNextTee = true;
    }

    // Set by WebRtcSession.RequestKeyFrame after an on-demand IDR so the
    // capture loop restarts its safety-net countdown from that keyframe
    // instead of firing a redundant full refresh moments later.
    private static int _keyframeClockReset = 0;

    /// <summary>
    /// SCOPE:TRANSPORT — signal the capture loop that a keyframe was just
    /// forced out-of-band (RTCP PLI/FIR). Safe to call from any thread.
    /// </summary>
    public static void ResetKeyframeClock() => Interlocked.Exchange(ref _keyframeClockReset, 1);

    private static bool ConsumeKeyframeClockReset() =>
        Interlocked.Exchange(ref _keyframeClockReset, 0) == 1;




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
            if (_logNextTee)
            {
                _logNextTee = false;
                Log.Info($"[t={WebRtcSession.MonoClock.ElapsedMilliseconds}] capture tee first-frame " +
                         $"{w}x{h} throttled={throttled} performanceMode={PerformanceMode}");
            }
            var rect = new Rectangle(0, 0, w, h);
            var data = scaled.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                // Pack tightly (width*4 per row, no stride padding). Encoder
                // package 8.0.7 routes VideoPixelFormatsEnum.Bgra through its
                // RGBA-to-I420 converter, so convert GDI's B,G,R,X bytes to
                // R,G,B,A here. Passing BGRA verbatim caused striped chroma.
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
                            for (int x = 0; x < rowBytes; x += 4)
                            {
                                drow[x] = srow[x + 2];
                                drow[x + 1] = srow[x + 1];
                                drow[x + 2] = srow[x];
                                drow[x + 3] = 0xFF;
                            }
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
    // The old two-state flip (5 slow uploads down, 30 clean seconds up) lived
    // here. It now delegates to BitrateController, which folds this HTTPS
    // signal together with the RTCP receiver reports from the video path so
    // both transports move the same ladder.
    private static void NoteUploadLatency(long ms) => BitrateController.NoteUploadLatency(ms);


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
