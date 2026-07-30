using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Media.Imaging;

namespace ConnectLive.Admin.Media;

/// <summary>
/// While WebRTC hasn't linked yet (or if it never does), we poll the JPEG
/// frames the agent uploads to session_frames — same fallback the web
/// console uses.
///
/// Two things keep this cheap:
///   * an `updated_at` cursor, so the server returns nothing when the agent
///     hasn't produced a new frame (no repeat downloads of the same JPEG);
///   * an adaptive cadence — ~200 ms while frames flow, backing off to 1 s
///     when the target machine is idle, snapping back on the next change.
/// </summary>
public sealed class FrameFallbackPump
{
    private readonly string _sessionId;
    private readonly Action<BitmapSource> _onFrame;
    private readonly Action<string>? _onError;
    private readonly Action? _onSuperseded;
    private readonly Action<DateTime>? _onFrameStamp;

    public FrameFallbackPump(string sessionId, Action<BitmapSource> onFrame,
        Action<string>? onError = null, Action? onSuperseded = null,
        Action<DateTime>? onFrameStamp = null)
    {
        _sessionId = sessionId;
        _onFrame = onFrame;
        _onError = onError;
        _onSuperseded = onSuperseded;
        _onFrameStamp = onFrameStamp;
    }

    public void Start(CancellationToken ct)
    {
        _ = Task.Run(() => Loop(ct), CancellationToken.None);
        _ = Task.Run(() => HeartbeatLoop(ct), CancellationToken.None);
    }

    // Idempotent 15s bind_admin heartbeat so the session binding stays
    // claimed even if WebRTC never negotiates. Safe to run alongside the
    // WebRtcClient heartbeat when both paths are alive.
    private async Task HeartbeatLoop(CancellationToken ct)
    {
        try
        {
            var initial = await App.Api.BindAdminAsync(_sessionId, ct).ConfigureAwait(false);
            if (!initial.bound && initial.reason == "superseded") { _onSuperseded?.Invoke(); return; }
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex) { _onError?.Invoke("Bind session: " + ex.Message); }

        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(15_000, ct).ConfigureAwait(false); } catch { return; }
            if (ct.IsCancellationRequested) return;
            try
            {
                var r = await App.Api.BindAdminAsync(_sessionId, ct).ConfigureAwait(false);
                if (!r.bound && r.reason == "superseded") { _onSuperseded?.Invoke(); return; }
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { _onError?.Invoke("Heartbeat: " + ex.Message); }
        }
    }

    private const int FastDelayMs = 200;   // frames are moving
    private const int IdleDelayMs = 1000;  // nothing new for a while
    private const int ErrorDelayMs = 2000; // link is unhappy

    private async Task Loop(CancellationToken ct)
    {
        int consecutiveFailures = 0;
        int consecutiveEmpty = 0;
        bool sawFrame = false;
        string? since = null;

        while (!ct.IsCancellationRequested)
        {
            int delay = FastDelayMs;
            try
            {
                var sample = await App.Api.GetLatestFrameAsync(_sessionId, since, ct).ConfigureAwait(false);
                if (sample != null && sample.Bytes.Length > 0)
                {
                    var bmp = Decode(sample.Bytes);
                    if (bmp != null)
                    {
                        if (!string.IsNullOrEmpty(sample.UpdatedAt)) since = sample.UpdatedAt;
                        _onFrame(bmp);
                        _onFrameStamp?.Invoke(DateTime.UtcNow);
                        if (!sawFrame) { sawFrame = true; _onError?.Invoke(""); }
                        consecutiveEmpty = 0;
                        delay = FastDelayMs;
                    }
                }
                else
                {
                    // Nothing newer than what we already show. Either the agent
                    // hasn't attached yet, or the remote screen is static.
                    consecutiveEmpty++;
                    if (!sawFrame && consecutiveEmpty == 15)
                        _onError?.Invoke("Waiting for agent to attach to this session…");
                    delay = consecutiveEmpty > 10 ? IdleDelayMs : FastDelayMs;
                }
                consecutiveFailures = 0;
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                consecutiveFailures++;
                if (consecutiveFailures == 3) _onError?.Invoke("Frame stream: " + ex.Message);
                delay = ErrorDelayMs;
            }

            try { await Task.Delay(delay, ct).ConfigureAwait(false); } catch { return; }
        }
    }

    private static BitmapSource? Decode(byte[] bytes)
    {
        try
        {
            using var ms = new MemoryStream(bytes);
            var decoder = BitmapDecoder.Create(ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
            if (decoder.Frames.Count == 0) return null;
            var f = decoder.Frames[0];
            f.Freeze();
            return f;
        }
        catch { return null; }
    }
}
