using System;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:TRANSPORT — the single owner of <c>(targetBitrate, maxEdge, fps)</c>.
///
/// Before this existed the pipeline had exactly two states: "sharp" (1920px,
/// q70/85) and "performance" (960px, q40/55), flipped by HTTPS upload latency
/// alone. That is a cliff, not a ladder: a link that could comfortably carry
/// 1280px got dropped to 960px, and the WebRTC path — which has *real*
/// receiver telemetry in its RTCP receiver reports — contributed nothing to
/// the decision at all.
///
/// This class turns that into a six-rung ladder and feeds it from both signals:
///   • <see cref="NoteReceiverReport"/> — RTCP RR loss fraction / jitter / RTT,
///     parsed in <see cref="WebRtcSession"/>. Authoritative for the video path.
///   • <see cref="NoteUploadLatency"/> — HTTPS frame POST round-trip. The only
///     signal available while the JPEG fallback is the active transport.
///
/// Policy is deliberately asymmetric, which is the whole point of a congestion
/// controller: step **down** fast (one rung per bad report, two on a severe
/// one) and climb **up** slowly (one rung after a sustained clean window).
/// Reacting slowly to congestion means the technician stares at a frozen
/// picture; reacting quickly to recovery means oscillation.
/// </summary>
public static class BitrateController
{
    /// <summary>One rung of the resolution / quality / cadence ladder.</summary>
    public sealed record Rung(
        int MaxEdge,
        long MotionQuality,
        long IdleQuality,
        int Fps,
        int TargetKbps)
    {
        /// <summary>Motion-frame delay, in ms, that realises <see cref="Fps"/>.</summary>
        public int FrameDelayMs => Math.Max(16, 1000 / Math.Max(1, Fps));
    }

    // Index 0 is the sharpest rung and the default: a healthy LAN or fibre
    // link should never leave it. The bottom rung is chosen to stay legible
    // for text-heavy support work (reading a dialog) rather than to look good.
    private static readonly Rung[] Ladder =
    {
        new(1920, 70, 85, 30, 4000),
        new(1600, 64, 80, 30, 2500),
        new(1280, 58, 74, 24, 1500),
        new(1024, 50, 66, 20,  900),
        new( 800, 44, 58, 15,  600),
        new( 640, 38, 50, 12,  350),
    };

    private static readonly object _gate = new();
    private static int _rung;
    private static DateTime _cleanSince = DateTime.MinValue;
    private static DateTime _lastChangeUtc = DateTime.MinValue;

    /// <summary>Raised after any rung change so capture can re-read tunables.</summary>
    public static event Action<Rung>? Changed;

    /// <summary>Current rung index; 0 = sharpest.</summary>
    public static int RungIndex { get { lock (_gate) return _rung; } }

    /// <summary>Live tunables. Read every frame — never cached across frames.</summary>
    public static Rung Current { get { lock (_gate) return Ladder[_rung]; } }

    /// <summary>Rung count, for logs and the eventual admin-side readout.</summary>
    public static int Rungs => Ladder.Length;

    /// <summary>
    /// New session / new peer: forget the previous link's history. Without
    /// this a second technician on a good link inherits the rung a first
    /// technician's hotel Wi-Fi dragged the encoder down to.
    /// </summary>
    public static void Reset()
    {
        bool changed;
        lock (_gate)
        {
            changed = _rung != 0;
            _rung = 0;
            _cleanSince = DateTime.MinValue;
            _lastChangeUtc = DateTime.MinValue;
        }
        if (changed) Announce("session reset");
    }

    /// <summary>
    /// RTCP receiver report from the admin. <paramref name="lossFraction"/> is
    /// 0..1 (the 8-bit RR field divided by 256), <paramref name="rttMs"/> may
    /// be 0 when no sender report has been echoed back yet.
    /// </summary>
    public static void NoteReceiverReport(double lossFraction, uint jitter, double rttMs)
    {
        // Severe: the receiver is dropping more than one packet in eight, or
        // the round trip is past the point where feedback is actionable.
        if (lossFraction >= 0.12 || rttMs >= 600)
        {
            Step(+2, $"rr loss={lossFraction:P1} rtt={rttMs:F0}ms (severe)");
            return;
        }
        if (lossFraction >= 0.04 || rttMs >= 350)
        {
            Step(+1, $"rr loss={lossFraction:P1} rtt={rttMs:F0}ms");
            return;
        }
        // Clean report. Jitter is advisory only: it rules out an *upgrade*
        // without ever forcing a downgrade, because high jitter on an
        // otherwise lossless link is usually a buffering artefact.
        NoteClean(jitter < 3000);
    }

    /// <summary>
    /// HTTPS frame-POST round trip, in ms. Same ladder, coarser signal: an
    /// upload that takes longer than the frame interval means the link cannot
    /// carry the current rung regardless of what the encoder wants.
    /// </summary>
    public static void NoteUploadLatency(long ms)
    {
        if (ms > 900) { Step(+2, $"upload {ms}ms (severe)"); return; }
        if (ms > 400)
        {
            // One slow POST is noise (GC pause, TLS resume). Two in a row is a link.
            lock (_gate) { _cleanSince = DateTime.MinValue; }
            if (++_badStreakVolatile >= 2) { _badStreakVolatile = 0; Step(+1, $"upload {ms}ms"); }
            return;
        }
        _badStreakVolatile = 0;
        NoteClean(ms < 200);
    }

    private static int _badStreakVolatile;

    private static void NoteClean(bool goodEnoughToClimb)
    {
        if (!goodEnoughToClimb)
        {
            lock (_gate) _cleanSince = DateTime.MinValue;
            return;
        }
        bool climb = false;
        lock (_gate)
        {
            if (_rung == 0) { _cleanSince = DateTime.MinValue; return; }
            // Never climb inside 10 s of the last change: that is the window in
            // which the previous step's effect is still in flight.
            if ((DateTime.UtcNow - _lastChangeUtc).TotalSeconds < 10) return;
            if (_cleanSince == DateTime.MinValue) { _cleanSince = DateTime.UtcNow; return; }
            if ((DateTime.UtcNow - _cleanSince).TotalSeconds >= 12)
            {
                _rung--;
                _cleanSince = DateTime.MinValue;
                _lastChangeUtc = DateTime.UtcNow;
                climb = true;
            }
        }
        if (climb) Announce("link healthy");
    }

    private static void Step(int down, string why)
    {
        bool changed = false;
        lock (_gate)
        {
            _cleanSince = DateTime.MinValue;
            // Rate-limit downgrades too: RTCP RRs arrive every ~1 s and a burst
            // of three would otherwise fall straight through the whole ladder.
            if ((DateTime.UtcNow - _lastChangeUtc).TotalSeconds < 3) return;
            int next = Math.Min(Ladder.Length - 1, _rung + Math.Max(1, down));
            if (next != _rung)
            {
                _rung = next;
                _lastChangeUtc = DateTime.UtcNow;
                changed = true;
            }
        }
        if (changed) Announce(why);
    }

    /// <summary>
    /// Legacy two-state entry point kept for callers that only know "sharp" or
    /// "performance". Maps onto the ladder instead of owning its own tunables.
    /// </summary>
    public static void Pin(bool performance)
    {
        bool changed;
        int target = performance ? 4 : 0;
        lock (_gate)
        {
            changed = _rung != target;
            _rung = target;
            _cleanSince = DateTime.MinValue;
            _lastChangeUtc = DateTime.UtcNow;
        }
        if (changed) Announce(performance ? "pinned performance" : "pinned sharp");
    }

    private static void Announce(string why)
    {
        var r = Current;
        Log.Info($"[t={WebRtcSession.MonoClock.ElapsedMilliseconds}] ladder -> rung {RungIndex}/{Ladder.Length - 1} " +
                 $"{r.MaxEdge}px q{r.MotionQuality}/{r.IdleQuality} {r.Fps}fps ~{r.TargetKbps}kbps ({why})");
        try { Changed?.Invoke(r); } catch { }
    }
}
