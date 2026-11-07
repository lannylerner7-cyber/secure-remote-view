using System;
using System.Threading;

namespace ConnectLive.Agent;

internal static class VideoPreflight
{
    private static int _started;

    internal static void LogStartup()
    {
        if (Interlocked.Exchange(ref _started, 1) != 0) return;
        Log.Info("video preflight: local dependencies and synthetic pixels only; no capture, network, pairing or repair");
        Vp8NativeDiagnostics.LogOnce();
        // These are separate failure boundaries, not a combined codec gate.
        try { HwEncoderProbe.LogCapability(); }
        catch (Exception ex) { Log.Warn($"video preflight H.264 discovery failed ({ex.GetType().Name}); VP8 check continues"); }
        try { CodecPolicy.LogPolicy(); }
        catch (Exception ex) { Log.Warn($"video preflight codec policy not reported ({ex.GetType().Name})"); }
        try
        {
            using var vp8 = Vp8FrameEncoder.TryCreate();
            Log.Info($"video preflight result: VP8={(vp8 != null ? "synthetic-encode-ok" : "unavailable")}; " +
                "hardware H.264 discovery is separate and is not an encoding test. " +
                "A session still needs a compatible offer, successful encoder initialization and actual frames.");
        }
        catch (Exception ex)
        {
            Log.Warn($"video preflight: VP8 check incomplete ({ex.GetType().Name}); H.264 eligibility unchanged");
        }
    }
}
