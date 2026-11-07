using System;

namespace ConnectLive.Agent;

/// <summary>
/// Hardware H.264 preference with an explicit software VP8 override.
/// Resolution order (first match wins):
///   1. <c>CONNECTLIVE_CODEC</c> environment variable: <c>vp8</c> | <c>auto</c> | <c>h264</c>
///   2. default: <c>auto</c>
///
/// <c>auto</c> means "H.264 when this machine has a hardware encoder, VP8
/// otherwise". The hardware probe must succeed; never silently choose a
/// software H.264 MFT. Actual negotiated codec is reported by WebRtcSession.
/// </summary>
public static class CodecPolicy
{
    /// <summary>What the operator asked for, independent of what the machine can do.</summary>
    public enum Mode
    {
        /// <summary>Software VP8 only — explicit compatibility override.</summary>
        Vp8Only = 0,
        /// <summary>H.264 when hardware is present, VP8 otherwise.</summary>
        Auto,
        /// <summary>H.264 preferred. Still falls back to VP8 when no hardware encoder exists.</summary>
        H264Preferred,
    }

    private const string EnvVar = "CONNECTLIVE_CODEC";

    private static readonly object _gate = new();
    private static bool _resolved;
    private static Mode _mode = Mode.Auto;
    private static string _source = "default";

    /// <summary>Operator-selected mode. Resolved once per process, then cached.</summary>
    public static Mode Selected
    {
        get { Resolve(); lock (_gate) return _mode; }
    }

    /// <summary>
    /// True when this build is permitted to advertise H.264 on the wire.
    ///
    /// A failed hardware encoder is also disabled for the remainder of its
    /// session by WebRtcSession; a new offer can then select VP8 safely.
    /// </summary>
    public static bool AllowH264
    {
        get
        {
            if (Selected == Mode.Vp8Only) return false;
            return SafeHardwareAvailable();
        }
    }

    /// <summary>
    /// The codec this build will actually put on the wire, as a short tag for
    /// heartbeat metadata and logs. Derived, never asserted: it has to match
    /// what <see cref="WebRtcSession"/> negotiates, or the fleet data lies.
    /// </summary>
    public static string WireCodecTag => WebRtcSession.Current?.WireCodecTag ?? "none";

    /// <summary>
    /// One line for the startup log, next to <see cref="HwEncoderProbe.LogCapability"/>.
    /// States the mode, where it came from, and what it resolves to, so a field
    /// machine's codec behaviour is readable from the log alone.
    /// </summary>
    public static void LogPolicy()
    {
        Resolve();
        string mode, source;
        lock (_gate) { mode = _mode.ToString(); source = _source; }
        Log.Info($"codec policy: mode={mode} (from {source}); preferred={(AllowH264 ? "H264" : "VP8")}; wire={WireCodecTag}; " +
                 $"hardware H.264 candidate {(SafeHardwareAvailable() ? "discovered" : "not discovered")}; " +
                 "preference/discovery is not proof that either encoder works. " +
                 $"Set {EnvVar}=vp8|auto|h264 to override.");
    }

    private static bool SafeHardwareAvailable()
    {
        try { return HwEncoderProbe.HardwareH264Available; }
        catch { return false; }
    }

    private static void Resolve()
    {
        lock (_gate)
        {
            if (_resolved) return;
            _resolved = true;

            string? raw = null;
            try { raw = Environment.GetEnvironmentVariable(EnvVar); }
            catch { /* a locked-down host must not take the agent down */ }

            if (string.IsNullOrWhiteSpace(raw))
            {
                _mode = Mode.Auto;
                _source = "default";
                return;
            }

            _source = EnvVar;
            switch (raw.Trim().ToLowerInvariant())
            {
                case "h264":
                case "h.264":
                    _mode = Mode.H264Preferred;
                    break;
                case "auto":
                    _mode = Mode.Auto;
                    break;
                case "vp8":
                    _mode = Mode.Vp8Only;
                    break;
                default:
                    // An unrecognised value is an operator typo, and the safe
                    // reading of a typo is "leave the wire codec alone".
                    Log.Warn($"codec policy: unrecognised {EnvVar}=\"{raw}\"; staying on VP8");
                    _mode = Mode.Vp8Only;
                    _source = $"{EnvVar} (invalid, ignored)";
                    break;
            }
        }
    }
}
