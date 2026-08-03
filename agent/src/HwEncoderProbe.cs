using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:CAPTURE — hardware H.264 encoder discovery (turn 4, stage 1).
///
/// Every Windows box since ~2013 ships an H.264 encoder Media Foundation
/// Transform, and on machines with a discrete GPU or a modern iGPU that MFT
/// is a thin shim over the vendor's silicon encoder: NVENC on NVIDIA,
/// Quick Sync (QSV) on Intel, AMF/VCE on AMD. Encoding there instead of in
/// libvpx on the CPU is the single largest sharpness-per-bit and
/// latency win available to this pipeline — a 1080p30 NVENC encode costs the
/// CPU essentially nothing, where software VP8 at the same settings is the
/// agent's dominant load and the reason the ladder has to give up resolution
/// on busy machines.
///
/// This class does the *discovery* half of that work and nothing else. It
/// answers one question honestly — "does this machine have a hardware H.264
/// encoder, and whose is it?" — and publishes the answer for logging,
/// heartbeat telemetry and the encoder-selection step that follows.
///
/// Deliberately NOT done here:
///   • wrapping the winning MFT in a SIPSorcery <c>IVideoEncoder</c>;
///   • changing the negotiated wire codec.
/// Both sides of the wire are still VP8-pinned (see the codec-pinning
/// guardrail comments in <see cref="WebRtcSession"/> and
/// <c>admin/src/Media/WebRtcClient.cs</c>). Flipping the wire codec before
/// the MFT wrapper exists would negotiate a stream nothing can encode.
///
/// Everything here is raw P/Invoke against mfplat.dll — no new package, no
/// native payload, so the single-file publish contract is untouched. Every
/// failure path degrades to "no hardware encoder found", which simply keeps
/// the existing software VP8 path.
/// </summary>
public static class HwEncoderProbe
{
    /// <summary>Which vendor's silicon encoder backs the discovered MFT.</summary>
    public enum HwVendor
    {
        /// <summary>No hardware H.264 encoder MFT registered on this machine.</summary>
        None = 0,
        /// <summary>NVIDIA NVENC.</summary>
        Nvenc,
        /// <summary>Intel Quick Sync Video.</summary>
        QuickSync,
        /// <summary>AMD AMF / VCE.</summary>
        Amf,
        /// <summary>A hardware MFT we could not attribute to a known vendor.</summary>
        Unknown,
    }

    private static readonly object _gate = new();
    private static bool _probed;
    private static HwVendor _vendor = HwVendor.None;
    private static string _encoderName = "";
    private static IReadOnlyList<string> _all = Array.Empty<string>();

    /// <summary>Vendor of the best hardware H.264 encoder found, or <see cref="HwVendor.None"/>.</summary>
    public static HwVendor Vendor { get { Probe(); lock (_gate) return _vendor; } }

    /// <summary>Friendly name of the selected MFT, or "" when there is none.</summary>
    public static string EncoderName { get { Probe(); lock (_gate) return _encoderName; } }

    /// <summary>Every hardware H.264 encoder MFT found, in MF's own preference order.</summary>
    public static IReadOnlyList<string> AllEncoders { get { Probe(); lock (_gate) return _all; } }

    /// <summary>
    /// True when this machine could carry a hardware H.264 stream.
    ///
    /// Nothing consumes this to change the wire codec yet — see the class
    /// remarks. It exists so the encoder-selection step landing next has a
    /// single, already-field-validated signal to branch on, and so the
    /// heartbeat can tell us what fraction of the fleet would actually
    /// benefit before we invest in the MFT wrapper.
    /// </summary>
    public static bool HardwareH264Available => Vendor != HwVendor.None;

    /// <summary>
    /// Short token for heartbeat metadata / logs: <c>nvenc</c>, <c>qsv</c>,
    /// <c>amf</c>, <c>hw</c> or <c>none</c>.
    /// </summary>
    public static string VendorTag => Vendor switch
    {
        HwVendor.Nvenc => "nvenc",
        HwVendor.QuickSync => "qsv",
        HwVendor.Amf => "amf",
        HwVendor.Unknown => "hw",
        _ => "none",
    };

    /// <summary>
    /// One line for the startup log. Called from <see cref="Agent.RunAsync"/>
    /// so every field log carries the machine's encoder capability whether or
    /// not a session is ever opened on it.
    /// </summary>
    public static void LogCapability()
    {
        Probe();
        if (HardwareH264Available)
        {
            Log.Info($"encoder probe: hardware H.264 available — {VendorTag} \"{EncoderName}\" " +
                     $"({AllEncoders.Count} hw MFT(s)); wire codec remains VP8 (software) this build");
        }
        else
        {
            Log.Info("encoder probe: no hardware H.264 MFT — software VP8 is the only encode path");
        }
    }

    /// <summary>Run the enumeration once per process; every later read is cached.</summary>
    public static void Probe()
    {
        lock (_gate)
        {
            if (_probed) return;
            _probed = true;
            try { _all = Enumerate(out _vendor, out _encoderName); }
            catch (Exception ex)
            {
                // A missing mfplat.dll (Windows N/KN without the media pack),
                // a locked-down container, or an MF startup failure all land
                // here. None of them are fatal: the software path is intact.
                Log.Warn($"encoder probe failed: {ex.Message}");
                _vendor = HwVendor.None;
                _encoderName = "";
                _all = Array.Empty<string>();
            }
        }
    }

    // ---- Media Foundation enumeration -------------------------------------

    private static List<string> Enumerate(out HwVendor vendor, out string best)
    {
        vendor = HwVendor.None;
        best = "";
        var names = new List<string>();

        int hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
        if (hr < 0) throw new InvalidOperationException($"MFStartup 0x{hr:X8}");

        try
        {
            // Output type filter: video / H.264. The input type is left null on
            // purpose — hardware encoders advertise wildly different input
            // subtypes (NV12 always, plus ARGB/YUY2 on some drivers) and
            // constraining it here would hide encoders we can feed after a
            // colour conversion we are doing anyway.
            var outType = new MFT_REGISTER_TYPE_INFO
            {
                guidMajorType = MFMediaType_Video,
                guidSubtype = MFVideoFormat_H264,
            };
            IntPtr outPtr = Marshal.AllocHGlobal(Marshal.SizeOf<MFT_REGISTER_TYPE_INFO>());
            Marshal.StructureToPtr(outType, outPtr, false);

            IntPtr activateArray = IntPtr.Zero;
            try
            {
                // HARDWARE only. Asking for SYNCMFT|ASYNCMFT alongside it is
                // required because vendor encoders register as async MFTs and
                // would otherwise be filtered out; SORTANDFILTER puts the
                // driver's preferred device first, which is what we want as
                // "best" on a hybrid-graphics laptop.
                const uint flags = MFT_ENUM_FLAG_HARDWARE |
                                   MFT_ENUM_FLAG_SYNCMFT |
                                   MFT_ENUM_FLAG_ASYNCMFT |
                                   MFT_ENUM_FLAG_SORTANDFILTER;

                hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags,
                               IntPtr.Zero, outPtr, out activateArray, out uint count);
                if (hr < 0) throw new InvalidOperationException($"MFTEnumEx 0x{hr:X8}");

                for (uint i = 0; i < count; i++)
                {
                    IntPtr unk = Marshal.ReadIntPtr(activateArray, (int)i * IntPtr.Size);
                    if (unk == IntPtr.Zero) continue;
                    try
                    {
                        var attrs = (IMFAttributes)Marshal.GetObjectForIUnknown(unk);
                        string name = ReadFriendlyName(attrs);
                        Marshal.ReleaseComObject(attrs);
                        if (string.IsNullOrWhiteSpace(name)) name = $"hardware H.264 encoder #{i}";
                        names.Add(name);
                    }
                    catch { /* one bad activate must not lose the rest */ }
                    finally { Marshal.Release(unk); }
                }
            }
            finally
            {
                if (activateArray != IntPtr.Zero) Marshal.FreeCoTaskMem(activateArray);
                Marshal.FreeHGlobal(outPtr);
            }
        }
        finally
        {
            try { MFShutdown(); } catch { }
        }

        if (names.Count > 0)
        {
            best = names[0];
            vendor = Classify(best);
            // SORTANDFILTER's first entry is the driver's preference, but on a
            // hybrid laptop that can be the iGPU while a far stronger discrete
            // encoder sits behind it. Prefer a vendor we recognise over an
            // unattributable one rather than trusting position blindly.
            if (vendor == HwVendor.Unknown)
            {
                foreach (var n in names)
                {
                    var v = Classify(n);
                    if (v != HwVendor.Unknown) { vendor = v; best = n; break; }
                }
            }
        }

        return names;
    }

    private static HwVendor Classify(string friendlyName)
    {
        var n = friendlyName.ToLowerInvariant();
        if (n.Contains("nvidia") || n.Contains("nvenc")) return HwVendor.Nvenc;
        if (n.Contains("intel") || n.Contains("quick sync") || n.Contains("quicksync")) return HwVendor.QuickSync;
        if (n.Contains("amd") || n.Contains("amf") || n.Contains("radeon")) return HwVendor.Amf;
        return HwVendor.Unknown;
    }

    private static string ReadFriendlyName(IMFAttributes attrs)
    {
        IntPtr str = IntPtr.Zero;
        try
        {
            var key = MFT_FRIENDLY_NAME_Attribute;
            int hr = attrs.GetAllocatedString(ref key, out str, out _);
            if (hr < 0 || str == IntPtr.Zero) return "";
            return Marshal.PtrToStringUni(str) ?? "";
        }
        catch { return ""; }
        finally { if (str != IntPtr.Zero) Marshal.FreeCoTaskMem(str); }
    }

    // ---- interop ----------------------------------------------------------

    private const uint MF_VERSION = 0x00020070;       // MF_SDK_VERSION<<16 | MF_API_VERSION
    private const uint MFSTARTUP_NOSOCKET = 1;

    private const uint MFT_ENUM_FLAG_SYNCMFT = 0x00000001;
    private const uint MFT_ENUM_FLAG_ASYNCMFT = 0x00000002;
    private const uint MFT_ENUM_FLAG_HARDWARE = 0x00000004;
    private const uint MFT_ENUM_FLAG_SORTANDFILTER = 0x00000040;

    private static readonly Guid MFT_CATEGORY_VIDEO_ENCODER =
        new("f79eac7d-e545-4387-bdee-d647d7bde42a");
    private static readonly Guid MFMediaType_Video =
        new("73646976-0000-0010-8000-00aa00389b71");
    private static readonly Guid MFVideoFormat_H264 =
        new("34363248-0000-0010-8000-00aa00389b71");
    private static readonly Guid MFT_FRIENDLY_NAME_Attribute =
        new("314ffbae-5b41-4c95-9c19-4e7d586face3");

    [StructLayout(LayoutKind.Sequential)]
    private struct MFT_REGISTER_TYPE_INFO
    {
        public Guid guidMajorType;
        public Guid guidSubtype;
    }

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFStartup(uint version, uint flags);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFShutdown();

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFTEnumEx(
        Guid guidCategory,
        uint flags,
        IntPtr pInputType,
        IntPtr pOutputType,
        out IntPtr pppMFTActivate,
        out uint pnumMFTActivate);

    /// <summary>
    /// Partial <c>IMFAttributes</c>. Only <c>GetAllocatedString</c> is called,
    /// but COM dispatch is by vtable slot, so every preceding method has to be
    /// declared in the exact IDL order to keep the offsets right. The
    /// placeholders below are intentionally untyped — do not "tidy" them by
    /// deleting one.
    /// </summary>
    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFAttributes
    {
        [PreserveSig] int GetItem(ref Guid key, IntPtr value);
        [PreserveSig] int GetItemType(ref Guid key, out int type);
        [PreserveSig] int CompareItem(ref Guid key, IntPtr value, out int result);
        [PreserveSig] int Compare(IntPtr theirs, int matchType, out int result);
        [PreserveSig] int GetUINT32(ref Guid key, out uint value);
        [PreserveSig] int GetUINT64(ref Guid key, out ulong value);
        [PreserveSig] int GetDouble(ref Guid key, out double value);
        [PreserveSig] int GetGUID(ref Guid key, out Guid value);
        [PreserveSig] int GetStringLength(ref Guid key, out uint length);
        [PreserveSig] int GetString(ref Guid key, IntPtr value, uint size, IntPtr length);
        [PreserveSig] int GetAllocatedString(ref Guid key, out IntPtr value, out uint length);
        // Remaining IMFAttributes members are never called from managed code
        // here; leaving them undeclared is safe because nothing dispatches to
        // a slot past this one.
    }
}
