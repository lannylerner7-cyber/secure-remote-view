using System;

namespace ConnectLive.Agent;

internal sealed record InputPauseSnapshot(
    bool Paused, string Epoch, long Revision, bool ReleaseConfirmed, bool OperatorPaused, string Reason);

/// <summary>
/// One execution barrier shared by the session, its current peer and HTTP input.
/// Mode/grant changes can only narrow it; only an explicitly authorized resume
/// opens it. The barrier never touches capture, the curtain or local input hooks.
/// </summary>
internal sealed class InputPauseGate
{
    private readonly object _gate = new();
    private readonly Func<bool> _release;
    private bool _paused = true, _released, _operatorPaused;
    private string _epoch = Guid.NewGuid().ToString("D");
    private long _revision;
    private string _reason = "awaiting_explicit_control";

    internal InputPauseGate(Func<bool>? release = null)
    {
        _release = release ?? (() => true);
        // A replacement scope may inherit tracked keys from failed cleanup.
        // Do not advertise confirmed release merely because this gate is new.
        Release();
    }

    internal InputPauseSnapshot State { get { lock (_gate) return Snapshot(); } }
    private InputPauseSnapshot Snapshot() => new(_paused, _epoch, _revision, _released, _operatorPaused, _reason);
    private void Rotate() { _epoch = Guid.NewGuid().ToString("D"); _revision++; }
    private bool Release()
    {
        try { _released = _release(); }
        catch { _released = false; }
        if (!_released) _reason = "held_input_release_unconfirmed";
        return _released;
    }

    internal void Block(string reason)
    {
        lock (_gate)
        {
            _paused = true;
            _reason = reason;
            if (reason == "view_only") _operatorPaused = false;
            Rotate();
            Release();
        }
    }

    internal bool Pause(string epoch, long revision)
    {
        lock (_gate)
        {
            if (_epoch != epoch || _revision != revision) return false;
            // Acquiring this lock has drained every admitted input callback.
            _paused = true; _operatorPaused = true; _reason = "operator_pause";
            Rotate();
            return Release();
        }
    }

    internal bool Resume(string epoch, long revision, Func<bool> authorized)
    {
        lock (_gate)
        {
            if (_epoch != epoch || _revision != revision || !_paused || !authorized()) return false;
            // Never resume over a failed key/button release.
            if (!Release()) return false;
            Rotate();
            _paused = false; _operatorPaused = false; _reason = "explicit_resume";
            return true;
        }
    }

    internal bool Apply(string? epoch, Func<bool> authorized, Action apply)
    {
        lock (_gate)
        {
            if (_paused || epoch == null || epoch != _epoch || !authorized()) return false;
            // Only bounded native input runs here, never UI-dispatching curtain
            // work. Pause cannot acknowledge until this operation has finished.
            apply();
            return true;
        }
    }
}
