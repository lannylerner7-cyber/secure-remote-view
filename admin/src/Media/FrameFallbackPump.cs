using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Media.Imaging;

namespace ConnectLive.Admin.Media;

/// <summary>
/// While WebRTC hasn't linked yet (or if it never does), we poll the JPEG
/// frames the agent uploads to session_frames — same fallback the web
/// console uses. Runs at ~5 fps.
/// </summary>
public sealed class FrameFallbackPump
{
    private readonly string _sessionId;
    private readonly Action<BitmapSource> _onFrame;
    private readonly Action<string>? _onError;
    private readonly Action? _onSuperseded;

    public FrameFallbackPump(string sessionId, Action<BitmapSource> onFrame,
        Action<string>? onError = null, Action? onSuperseded = null)
    {
        _sessionId = sessionId;
        _onFrame = onFrame;
        _onError = onError;
        _onSuperseded = onSuperseded;
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
            var initial = await App.Api.BindAdminAsync(_sessionId, ct);
            if (!initial.bound && initial.reason == "superseded") { _onSuperseded?.Invoke(); return; }
        }
        catch (Exception ex) { _onError?.Invoke("Bind session: " + ex.Message); }

        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(15_000, ct); } catch { return; }
            if (ct.IsCancellationRequested) return;
            try
            {
                var r = await App.Api.BindAdminAsync(_sessionId, ct);
                if (!r.bound && r.reason == "superseded") { _onSuperseded?.Invoke(); return; }
            }
            catch (Exception ex) { _onError?.Invoke("Heartbeat: " + ex.Message); }
        }
    }

    private async Task Loop(CancellationToken ct)
    {
        int consecutiveFailures = 0;
        int consecutiveEmpty = 0;
        bool sawFrame = false;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var bytes = await App.Api.GetLatestFrameAsync(_sessionId, ct);
                if (bytes != null && bytes.Length > 0)
                {
                    var bmp = Decode(bytes);
                    if (bmp != null)
                    {
                        _onFrame(bmp);
                        if (!sawFrame) { sawFrame = true; _onError?.Invoke(""); }
                        consecutiveEmpty = 0;
                    }
                }
                else
                {
                    // Empty result — the session row exists but the agent
                    // hasn't uploaded a frame yet. Surface after ~3s so the
                    // black screen isn't silent.
                    consecutiveEmpty++;
                    if (!sawFrame && consecutiveEmpty == 15)
                        _onError?.Invoke("Waiting for agent to attach to this session…");
                }
                consecutiveFailures = 0;
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                consecutiveFailures++;
                if (consecutiveFailures == 3) _onError?.Invoke("Frame stream: " + ex.Message);
            }
            try { await Task.Delay(consecutiveFailures > 0 ? 2000 : 200, ct); } catch { }
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
