using System;

namespace ConnectLive.Agent;

/// <summary>Bound retry pressure from the optional JPEG path without slowing
/// capture/WebRTC or changing the three-second per-request deadline.</summary>
internal sealed class FrameUploadBackoff
{
    private int _failures;

    internal TimeSpan Observe(bool uploaded)
    {
        if (uploaded) { _failures = 0; return TimeSpan.Zero; }
        _failures = Math.Min(_failures + 1, 5);
        return TimeSpan.FromMilliseconds(Math.Min(500 << (_failures - 1), 5000));
    }
}
