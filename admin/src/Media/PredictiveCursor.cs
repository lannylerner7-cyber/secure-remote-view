using System;
using System.Diagnostics;

namespace ConnectLive.Admin.Media;

/// <summary>
/// SCOPE:RENDER — predictive cursor.
///
/// The ghost pointer used to be drawn purely from agent telemetry
/// (<see cref="CursorPollPump"/> / <see cref="RealtimeChannel"/>), so it
/// trailed the technician's real hand by a full network round trip. That one
/// detail is what makes a remote session read as "remote software" instead of
/// "my mouse".
///
/// The fix is client-side prediction with server reconciliation — the same
/// contract a game netcode layer uses:
///
///   * <see cref="Predict"/> is called the instant the technician moves over
///     the video surface. The ghost jumps there immediately: zero perceived
///     latency, because the pointer is drawn from local input, not from a
///     round trip.
///   * <see cref="Observe"/> feeds the authoritative agent sample in. While
///     prediction is trusted the truth is *eased* toward, never snapped to —
///     snapping is what produces the rubber-band jitter that feels worse than
///     plain lag.
///   * When telemetry disagrees past <see cref="DisagreeThreshold"/> for
///     <see cref="DisagreeSamples"/> consecutive samples, the agent-side
///     pointer is genuinely somewhere else (the user moved their own mouse, or
///     our input was rejected / the session isn't in control mode). Prediction
///     surrenders and telemetry takes the pointer back.
///   * Prediction also expires on its own after <see cref="HoldMs"/> with no
///     local movement, so an idle overlay always converges on the truth.
///
/// Honesty rule: <see cref="Enabled"/> is forced false whenever the session is
/// not actually accepting our input (view mode, paused, curtain-less, taken
/// over). The overlay must never claim a pointer position the remote machine
/// isn't going to honour.
///
/// Pure math + a stopwatch, no WPF types — the window owns the drawing, this
/// owns the decision.
/// </summary>
public sealed class PredictiveCursor
{
    /// <summary>Normalised distance (0..1 of the picture) beyond which telemetry is "disagreeing".</summary>
    public const double DisagreeThreshold = 0.045;

    /// <summary>Consecutive disagreeing samples before prediction surrenders.</summary>
    public const int DisagreeSamples = 3;

    /// <summary>No local movement for this long → prediction expires, telemetry owns the pointer.</summary>
    public const int HoldMs = 700;

    /// <summary>How hard each telemetry sample pulls the prediction toward truth (0..1).</summary>
    private const double EaseFactor = 0.18;

    /// <summary>Per-frame convergence used while fading prediction out after a surrender.</summary>
    private const double FadeFactor = 0.30;

    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly object _gate = new();

    private double _predX, _predY;          // locally predicted point (normalised)
    private double _truthX, _truthY;        // last authoritative sample (normalised)
    private bool _haveTruth;
    private bool _truthVisible;
    private bool _predicting;
    private bool _fading;
    private long _lastPredictMs = -1;
    private int _disagreeStreak;

    /// <summary>
    /// Master switch. False = telemetry-only (the pre-prediction behaviour).
    /// The view model flips this with the control/curtain state so a paused or
    /// view-only session can never show a pointer the agent isn't tracking.
    /// </summary>
    public bool Enabled
    {
        get { lock (_gate) return _enabled; }
        set
        {
            lock (_gate)
            {
                if (_enabled == value) return;
                _enabled = value;
                if (!value) SurrenderLocked();
            }
        }
    }
    private bool _enabled;

    /// <summary>True while the drawn pointer comes from local input rather than the agent.</summary>
    public bool IsPredicting { get { lock (_gate) return _predicting; } }

    /// <summary>Diagnostic: how many consecutive samples currently disagree.</summary>
    public int DisagreeStreak { get { lock (_gate) return _disagreeStreak; } }

    /// <summary>
    /// Local input — the technician's pointer is here, right now. Called from
    /// the UI thread on every mouse move over the picture.
    /// </summary>
    public void Predict(double normX, double normY)
    {
        if (!double.IsFinite(normX) || !double.IsFinite(normY)) return;
        lock (_gate)
        {
            if (!_enabled) return;
            _predX = Math.Clamp(normX, 0, 1);
            _predY = Math.Clamp(normY, 0, 1);
            _predicting = true;
            _fading = false;
            _disagreeStreak = 0;
            _lastPredictMs = _clock.ElapsedMilliseconds;
        }
    }

    /// <summary>
    /// Authoritative agent telemetry. <paramref name="visible"/> false means
    /// the agent reports no cursor (hidden by a game, or off the captured
    /// monitor) — prediction surrenders because we can no longer reconcile.
    /// </summary>
    public void Observe(double normX, double normY, bool visible)
    {
        lock (_gate)
        {
            _truthVisible = visible;
            if (!visible)
            {
                _haveTruth = false;
                SurrenderLocked();
                return;
            }
            if (!double.IsFinite(normX) || !double.IsFinite(normY)) return;

            _truthX = Math.Clamp(normX, 0, 1);
            _truthY = Math.Clamp(normY, 0, 1);
            _haveTruth = true;

            if (!_predicting) return;

            var dx = _truthX - _predX;
            var dy = _truthY - _predY;
            var dist = Math.Sqrt(dx * dx + dy * dy);

            if (dist > DisagreeThreshold)
            {
                // The agent's pointer is somewhere our prediction can't explain:
                // either the local user grabbed their mouse, or our input never
                // landed. Give it a few samples so a single late/stale row
                // doesn't yank the overlay, then hand the pointer back.
                if (++_disagreeStreak >= DisagreeSamples) SurrenderLocked();
                return;
            }

            // Agreement: ease toward truth so accumulated prediction error is
            // absorbed smoothly instead of snapping.
            _disagreeStreak = 0;
            _predX += dx * EaseFactor;
            _predY += dy * EaseFactor;
        }
    }

    /// <summary>Session-level surrender (mode change, pause, take-over, teardown).</summary>
    public void Surrender()
    {
        lock (_gate) SurrenderLocked();
    }

    private void SurrenderLocked()
    {
        if (_predicting) _fading = true;   // converge visually rather than teleport
        _predicting = false;
        _disagreeStreak = 0;
        _lastPredictMs = -1;
    }

    /// <summary>Full reset between sessions.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _predicting = false;
            _fading = false;
            _haveTruth = false;
            _truthVisible = false;
            _disagreeStreak = 0;
            _lastPredictMs = -1;
        }
    }

    /// <summary>
    /// The point to draw this frame, in normalised source space.
    /// Call once per render tick — it also advances the expiry and fade.
    /// </summary>
    public (double x, double y, bool visible) Sample()
    {
        lock (_gate)
        {
            // Expire a stale prediction: the hand stopped moving, so the truth
            // has had time to catch up and should own the pointer again.
            if (_predicting && _lastPredictMs >= 0 &&
                _clock.ElapsedMilliseconds - _lastPredictMs > HoldMs)
            {
                SurrenderLocked();
            }

            if (_predicting) return (_predX, _predY, true);

            if (!_haveTruth || !_truthVisible)
            {
                _fading = false;
                return (_predX, _predY, false);
            }

            if (_fading)
            {
                // Walk the last predicted point into the authoritative one over
                // a handful of frames, then stop tracking it.
                _predX += (_truthX - _predX) * FadeFactor;
                _predY += (_truthY - _predY) * FadeFactor;
                if (Math.Abs(_truthX - _predX) < 0.002 && Math.Abs(_truthY - _predY) < 0.002)
                {
                    _predX = _truthX;
                    _predY = _truthY;
                    _fading = false;
                }
                return (_predX, _predY, true);
            }

            _predX = _truthX;
            _predY = _truthY;
            return (_truthX, _truthY, true);
        }
    }
}
