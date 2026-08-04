using System;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:TRANSPORT — S17 step 3 kill switch, landed ahead of the encoder it
/// governs.
///
/// The wire codec is the one contract all three peers (agent, native admin,
/// web console) must agree on. If any peer pins VP8 while another negotiates
/// H.264, the session is black with no obvious diagnostic — which is exactly
/// why the hard VP8 pin in <see cref="WebRtcSession"/> exists today.
///
/// This class is the single place that answers "which codec may this build put
/// on the wire?", so the answer can be changed in the field without a code
/// rollback once the hardware encoder lands. It ships deliberately EARLY:
///
///   • today nothing consumes <see cref="AllowH264"/> — <see cref="WebRtcSession"/>
///     still pins VP8 unconditionally, so this build's behaviour is unchanged;
///   • when the MFT wrapper lands, that pin reads this class instead, and a bad
///     encoder in the field is one environment variable away from being off.
///
/// Resolution order (first match wins):
///   1. <c>CONNECTLIVE_CODEC</c> environment variable: <c>vp8</c> | <c>auto</c> | <c>h264</c>
///   2. default: <c>vp8</c>
///
/// <c>auto</c> means "H.264 when this machine has a hardware encoder, VP8
/// otherwise". It is never the default: Windows always offers a SOFTWARE H.264
/// MFT, and that is slower than libvpx VP8, so drifting into H.264 on a machine
/// without silicon would be a regression rather than a win.
/// </summary>
public static class CodecPolicy
{
    /// <summary>What the operator asked for, independent of what the machine can do.</summary>
    public enum Mode
    {
        /// <summary>Software VP8 only — the shipping default and the safe answer.</summary>
        Vp8Only = 0,
        /// <summary>H.264 when hardware is present, VP8 otherwise.</summary>
        Auto,
        /// <summary>H.264 preferred. Still falls back to VP8 when no hardware encoder exists.</summary>
        H264Preferred,
    }

    private const string EnvVar = "CONNECTLIVE_CODEC";

    private static readonly object _gate = new();
    private static bool _resolved;
    private static Mode _mode = Mode.Vp8Only;
    private static string _source = "default";

    /// <summary>Operator-selected mode. Resolved once per process, then cached.</summary>
    public static Mode Selected
    {
        get { Resolve(); lock (_gate) return _mode; }
    }

    /// <summary>
    /// True when this build is permitted to advertise H.264 on the wire.
    ///
    /// NOTHING CONSUMES THIS YET. Flipping the VP8 pin in
    /// <see cref="WebRtcSession"/> to read this property is the first line of
    /// S17 step 3, and it must land in the same change as the MFT wrapper and
    /// the admin-side Media Foundation decoder. Advertising a codec the agent
    /// cannot actually encode negotiates a stream nothing can produce.
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
    public static string WireCodecTag => AllowH264 ? "H264" : "VP8";

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
        Log.Info($"codec policy: mode={mode} (from {source}) -> wire={WireCodecTag}; " +
                 $"hardware H.264 {(SafeHardwareAvailable() ? "available" : "absent")}. " +
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
                _mode = Mode.Vp8Only;
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
