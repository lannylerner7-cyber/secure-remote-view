namespace ConnectLive.Agent;

/// <summary>Bounded, same-codec recovery; never changes session permission.</summary>
internal sealed class EncoderProgress
{
    private long _lastOutputAt = -1;
    private int _emptyFrames;
    private int _restarts;
    internal int Restarts => _restarts;

    internal bool Observe(long now, bool produced)
    {
        if (produced)
        {
            _lastOutputAt = now;
            _emptyFrames = 0;
            return false;
        }
        if (_lastOutputAt < 0) _lastOutputAt = now;
        _emptyFrames++;
        // An idle desktop is not a stall: this runs only on submitted frames.
        return _emptyFrames >= 8 && now - _lastOutputAt >= 3000;
    }

    internal bool TryRestart(long now)
    {
        if (_restarts >= 2) return false;
        _restarts++;
        _lastOutputAt = now;
        _emptyFrames = 0;
        return true;
    }
}
