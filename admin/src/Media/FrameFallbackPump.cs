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

    public FrameFallbackPump(string sessionId, Action<BitmapSource> onFrame)
    {
        _sessionId = sessionId;
        _onFrame = onFrame;
    }

    public void Start(CancellationToken ct) => _ = Task.Run(() => Loop(ct), CancellationToken.None);

    private async Task Loop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var bytes = await App.Api.GetLatestFrameAsync(_sessionId, ct);
                if (bytes != null && bytes.Length > 0)
                {
                    var bmp = Decode(bytes);
                    if (bmp != null) _onFrame(bmp);
                }
            }
            catch { /* transient */ }
            try { await Task.Delay(200, ct); } catch { }
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
