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

    public FrameFallbackPump(string sessionId, Action<BitmapSource> onFrame, Action<string>? onError = null)
    {
        _sessionId = sessionId;
        _onFrame = onFrame;
        _onError = onError;
    }

    public void Start(CancellationToken ct) => _ = Task.Run(() => Loop(ct), CancellationToken.None);

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
