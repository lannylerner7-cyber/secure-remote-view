using System;
using System.Threading;

namespace ConnectLive.Agent;

internal enum CaptureSource
{
    Unknown = 0,
    Dxgi = 1,
    Gdi = 2,
    ProtectedDesktop = 3,
}

/// <summary>
/// Low-cost, content-free capture freshness markers for local diagnostics.
/// Poll, successful sample, and changed-content ages are kept separate so a
/// static desktop is not mistaken for a stalled capture loop.
/// </summary>
internal static class CaptureHealth
{
    private static long _lastLoopMs = -1;
    private static long _lastPollMs = -1;
    private static long _lastSampleMs = -1;
    private static long _lastChangeMs = -1;
    private static int _pollSource;
    private static int _sampleSource;
    private static int _width;
    private static int _height;

    public static void Reset()
    {
        Interlocked.Exchange(ref _lastLoopMs, -1);
        Interlocked.Exchange(ref _lastPollMs, -1);
        Interlocked.Exchange(ref _lastSampleMs, -1);
        Interlocked.Exchange(ref _lastChangeMs, -1);
        Interlocked.Exchange(ref _pollSource, (int)CaptureSource.Unknown);
        Interlocked.Exchange(ref _sampleSource, (int)CaptureSource.Unknown);
        Interlocked.Exchange(ref _width, 0);
        Interlocked.Exchange(ref _height, 0);
    }

    public static void LoopTick() => Interlocked.Exchange(ref _lastLoopMs, Environment.TickCount64);

    public static void Poll(CaptureSource source)
    {
        Interlocked.Exchange(ref _pollSource, (int)source);
        Interlocked.Exchange(ref _lastPollMs, Environment.TickCount64);
    }

    public static void ProtectedDesktop()
    {
        Interlocked.Exchange(ref _pollSource, (int)CaptureSource.ProtectedDesktop);
        Interlocked.Exchange(ref _lastPollMs, Environment.TickCount64);
    }

    public static void Sample(CaptureSource source, int width, int height, bool contentChanged)
    {
        var now = Environment.TickCount64;
        Interlocked.Exchange(ref _sampleSource, (int)source);
        Interlocked.Exchange(ref _lastSampleMs, now);
        Interlocked.Exchange(ref _width, width);
        Interlocked.Exchange(ref _height, height);
        if (contentChanged) Interlocked.Exchange(ref _lastChangeMs, now);
    }

    public static string DiagnosticLine()
    {
        var now = Environment.TickCount64;
        return $"[capture] path={Name(Interlocked.CompareExchange(ref _pollSource, 0, 0))} " +
               $"loop_age_ms={Age(now, Interlocked.Read(ref _lastLoopMs))} " +
               $"poll_age_ms={Age(now, Interlocked.Read(ref _lastPollMs))} " +
               $"sample_source={Name(Interlocked.CompareExchange(ref _sampleSource, 0, 0))} " +
               $"sample_age_ms={Age(now, Interlocked.Read(ref _lastSampleMs))} " +
               $"content_change_age_ms={Age(now, Interlocked.Read(ref _lastChangeMs))} " +
               $"size={Interlocked.CompareExchange(ref _width, 0, 0)}x{Interlocked.CompareExchange(ref _height, 0, 0)}";
    }

    private static string Age(long now, long timestamp) =>
        timestamp < 0 ? "none" : Math.Max(0, now - timestamp).ToString();

    private static string Name(int source) => (CaptureSource)source switch
    {
        CaptureSource.Dxgi => "DXGI",
        CaptureSource.Gdi => "GDI",
        CaptureSource.ProtectedDesktop => "protected",
        _ => "unknown",
    };
}
