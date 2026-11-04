using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:CAPTURE — hardware H.264 encoder (brain-engine phase 1).
///
/// Wraps whichever hardware H.264 Media Foundation Transform
/// <see cref="HwEncoderProbe"/> found — NVENC, Quick Sync or AMF — behind a
/// tiny "BGRA in, Annex-B access unit out" surface that
/// <see cref="WebRtcSession"/> can hand straight to SIPSorcery's H.264
/// packetiser.
///
/// WHY THIS EXISTS
/// Software VP8 is the agent's dominant CPU cost and the reason the resolution
/// ladder had to be pinned at 1920px: encoding 4K in libvpx on the CPU
/// collapses the session. A hardware encode is close to free, which is what
/// earns the right to lift that ceiling and send a sharp, 1:1 desktop.
///
/// DESIGN RULES
///   • Additive only. Every failure path here returns false/null; the caller
///     keeps the existing software VP8 route. A broken driver must never
///     produce a connected-but-black session.
///   • Supports both MFT flavours. Vendor encoders register as *asynchronous*
///     MFTs, which cannot simply be ProcessInput/ProcessOutput'd: they must be
///     unlocked and then driven by METransformNeedInput / METransformHaveOutput
///     events. Intel's and some software MFTs are synchronous. Both are
///     handled; the flavour is detected at init.
///   • One encoder per peer, one thread. <see cref="Encode"/> is called from
///     the capture tee only. It is guarded by a lock anyway, because
///     <see cref="ForceKeyFrame"/> arrives on the RTCP thread.
///   • Geometry changes rebuild the MFT rather than trying to renegotiate it
///     in place; a monitor switch mid-session is rare and correctness beats
///     the few hundred milliseconds.
/// </summary>
public sealed class HwH264Encoder : IDisposable
{
    private static readonly Guid IID_IMFTransform = new("bf94c121-5b05-4e6f-8000-ba598961414d");

    private readonly object _gate = new();

    private Mf.IMFTransform? _mft;
    private Mf.IMFMediaEventGenerator? _events;
    private object? _codecApi;
    private bool _async;
    private bool _outputProvidesSamples;
    private uint _outputBufferSize;
    private bool _dead;
    private string _deadReason = "";

    private int _width, _height, _fps, _bitrateBps;
    private long _frameIndex;
    private byte[]? _nv12;
    private readonly List<byte> _accessUnit = new(256 * 1024);
    // Async MFT input credits (METransformNeedInput). Tracked ACROSS Encode
    // calls so a request that arrives when we have nothing to feed is banked,
    // not discarded — discarding it wedged the pump into a 120 ms spin-and-skip
    // on every later frame. Only ever touched under _gate (Encode holds it).
    private int _pendingInputCredits;

    /// <summary>Friendly name of the MFT actually driving this encoder.</summary>
    public string EncoderName { get; private set; } = "";

    /// <summary>Vendor tag from the probe, for logs and heartbeat metadata.</summary>
    public string VendorTag => HwEncoderProbe.VendorTag;

    /// <summary>False once the MFT has thrown; the caller must fall back to VP8.</summary>
    public bool IsAlive => !_dead;

    /// <summary>Why the encoder retired, or "" while healthy.</summary>
    public string DeadReason => _deadReason;

    private HwH264Encoder() { }

    /// <summary>
    /// Build an encoder for the given geometry, or return null when this
    /// machine cannot do it. Null is a normal, expected answer — it simply
    /// means the session stays on software VP8.
    /// </summary>
    public static HwH264Encoder? TryCreate(int width, int height, int fps, int bitrateKbps)
    {
        if (!CodecPolicy.AllowH264)
        {
            Log.Info("h264: codec policy says VP8 only — hardware encoder not attempted");
            return null;
        }
        if (width < 16 || height < 16) return null;

        var enc = new HwH264Encoder();
        try
        {
            if (!enc.Initialise(width, height, fps, bitrateKbps))
            {
                enc.Dispose();
                return null;
            }
            Log.Info($"h264: hardware encoder ready — {enc.VendorTag} \"{enc.EncoderName}\" " +
                     $"{width}x{height}@{fps} ~{bitrateKbps}kbps ({(enc._async ? "async" : "sync")} MFT)");
            return enc;
        }
        catch (Exception ex)
        {
            Log.Warn($"h264: hardware encoder init failed ({ex.Message}) — staying on VP8");
            try { enc.Dispose(); } catch { }
            return null;
        }
    }

    // ---- initialisation ----------------------------------------------------

    private bool Initialise(int width, int height, int fps, int bitrateKbps)
    {
        if (!Mf.EnsureStarted()) { Fail("MFStartup failed"); return false; }

        _width = width & ~1;
        _height = height & ~1;
        _fps = Math.Clamp(fps, 5, 60);
        _bitrateBps = Math.Clamp(bitrateKbps, 200, 40000) * 1000;

        if (!ActivateTransform()) return false;
        if (!ConfigureTransform()) return false;

        // BEGIN_STREAMING before START_OF_STREAM: the first tells the driver to
        // allocate, the second opens the stream. Async MFTs only start raising
        // METransformNeedInput after both.
        Send(Mf.MFT_MESSAGE_NOTIFY_BEGIN_STREAMING);
        Send(Mf.MFT_MESSAGE_NOTIFY_START_OF_STREAM);
        return true;
    }

    private bool ActivateTransform()
    {
        var outInfo = new Mf.MFT_REGISTER_TYPE_INFO
        {
            guidMajorType = Mf.MFMediaType_Video,
            guidSubtype = Mf.MFVideoFormat_H264,
        };
        IntPtr outPtr = Marshal.AllocHGlobal(Marshal.SizeOf<Mf.MFT_REGISTER_TYPE_INFO>());
        Marshal.StructureToPtr(outInfo, outPtr, false);

        IntPtr activateArray = IntPtr.Zero;
        try
        {
            const uint flags = Mf.MFT_ENUM_FLAG_HARDWARE |
                               Mf.MFT_ENUM_FLAG_SYNCMFT |
                               Mf.MFT_ENUM_FLAG_ASYNCMFT |
                               Mf.MFT_ENUM_FLAG_SORTANDFILTER;

            int hr = Mf.MFTEnumEx(Mf.MFT_CATEGORY_VIDEO_ENCODER, flags,
                                  IntPtr.Zero, outPtr, out activateArray, out uint count);
            if (hr < 0 || count == 0) { Fail($"no hardware H.264 MFT (0x{hr:X8}, count={count})"); return false; }

            for (uint i = 0; i < count; i++)
            {
                IntPtr unk = Marshal.ReadIntPtr(activateArray, (int)i * IntPtr.Size);
                if (unk == IntPtr.Zero) continue;
                if (_mft != null) { Marshal.Release(unk); continue; }

                object? activateObj = null;
                try
                {
                    activateObj = Marshal.GetObjectForIUnknown(unk);
                    if (activateObj is not Mf.IMFActivate activate) continue;

                    string name = ReadFriendlyName(activate);
                    var iid = IID_IMFTransform;
                    if (activate.ActivateObject(ref iid, out IntPtr transformPtr) < 0 || transformPtr == IntPtr.Zero)
                        continue;

                    try
                    {
                        var obj = Marshal.GetObjectForIUnknown(transformPtr);
                        if (obj is Mf.IMFTransform t)
                        {
                            _mft = t;
                            _codecApi = obj;
                            EncoderName = string.IsNullOrWhiteSpace(name) ? $"hardware H.264 encoder #{i}" : name;
                        }
                    }
                    finally { Marshal.Release(transformPtr); }
                }
                catch { /* a single bad MFT must not lose the rest */ }
                finally
                {
                    if (activateObj != null) { try { Marshal.ReleaseComObject(activateObj); } catch { } }
                    Marshal.Release(unk);
                }
            }
        }
        finally
        {
            if (activateArray != IntPtr.Zero) Marshal.FreeCoTaskMem(activateArray);
            Marshal.FreeHGlobal(outPtr);
        }

        if (_mft == null) { Fail("no hardware H.264 MFT could be activated"); return false; }
        return true;
    }

    private bool ConfigureTransform()
    {
        var mft = _mft!;

        // ---- async unlock + low latency -----------------------------------
        if (mft.GetAttributes(out var attrs) >= 0 && attrs != null)
        {
            try
            {
                var asyncKey = Mf.MF_TRANSFORM_ASYNC;
                if (attrs.GetUINT32(ref asyncKey, out uint isAsync) >= 0 && isAsync == 1)
                {
                    _async = true;
                    var unlock = Mf.MF_TRANSFORM_ASYNC_UNLOCK;
                    attrs.SetUINT32(ref unlock, 1);
                }
                var lowLatency = Mf.MF_LOW_LATENCY;
                attrs.SetUINT32(ref lowLatency, 1);
            }
            finally { try { Marshal.ReleaseComObject(attrs); } catch { } }
        }

        if (_async)
        {
            _events = mft as Mf.IMFMediaEventGenerator;
            if (_events == null) { Fail("async MFT without IMFMediaEventGenerator"); return false; }
        }

        // ---- output type must be set BEFORE the input type ------------------
        if (!BuildOutputType(out IntPtr outType)) return false;
        try
        {
            int hr = mft.SetOutputType(0, outType, 0);
            if (hr < 0) { Fail($"SetOutputType 0x{hr:X8}"); return false; }
        }
        finally { if (outType != IntPtr.Zero) Marshal.Release(outType); }

        if (!BuildInputType(out IntPtr inType)) return false;
        try
        {
            int hr = mft.SetInputType(0, inType, 0);
            if (hr < 0) { Fail($"SetInputType NV12 0x{hr:X8}"); return false; }
        }
        finally { if (inType != IntPtr.Zero) Marshal.Release(inType); }

        // ---- output allocation contract --------------------------------------
        if (mft.GetOutputStreamInfo(0, out var info) >= 0)
        {
            _outputProvidesSamples =
                (info.dwFlags & (Mf.MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | Mf.MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
            _outputBufferSize = Math.Max(info.cbSize, (uint)(_width * _height));
        }
        else
        {
            _outputBufferSize = (uint)(_width * _height);
        }

        ApplyCodecApi();
        return true;
    }

    private void ApplyCodecApi()
    {
        // Best effort throughout: a driver that refuses a knob simply keeps its
        // default. None of these are required for a valid stream, but together
        // they are the difference between "interactive" and "buffered".
        Mf.TrySetCodecApi(_codecApi, Mf.CODECAPI_AVLowLatencyMode, Mf.PropVariant.FromBool(true));
        Mf.TrySetCodecApi(_codecApi, Mf.CODECAPI_AVEncCommonRateControlMode,
                          Mf.PropVariant.FromUInt32(Mf.eAVEncCommonRateControlMode_CBR));
        Mf.TrySetCodecApi(_codecApi, Mf.CODECAPI_AVEncCommonMeanBitRate,
                          Mf.PropVariant.FromUInt32((uint)_bitrateBps));
        // Two-second GOP. Long enough that steady state is cheap, short enough
        // that a decoder joining after loss recovers without a PLI round trip.
        Mf.TrySetCodecApi(_codecApi, Mf.CODECAPI_AVEncMPVGOPSize,
                          Mf.PropVariant.FromUInt32((uint)(_fps * 2)));
        // 0 = fastest, 100 = best quality. A remote desktop wants latency.
        Mf.TrySetCodecApi(_codecApi, Mf.CODECAPI_AVEncCommonQualityVsSpeed, Mf.PropVariant.FromUInt32(33));
    }

    private bool BuildOutputType(out IntPtr type)
    {
        type = IntPtr.Zero;
        if (Mf.MFCreateMediaType(out type) < 0 || type == IntPtr.Zero) { Fail("MFCreateMediaType (output)"); return false; }
        if (Marshal.GetObjectForIUnknown(type) is not Mf.IMFAttributes a) { Fail("output type QI"); return false; }
        try
        {
            var major = Mf.MF_MT_MAJOR_TYPE; var video = Mf.MFMediaType_Video;
            a.SetGUID(ref major, ref video);
            var sub = Mf.MF_MT_SUBTYPE; var h264 = Mf.MFVideoFormat_H264;
            a.SetGUID(ref sub, ref h264);
            var br = Mf.MF_MT_AVG_BITRATE; a.SetUINT32(ref br, (uint)_bitrateBps);
            var size = Mf.MF_MT_FRAME_SIZE; a.SetUINT64(ref size, Mf.Pack2((uint)_width, (uint)_height));
            var rate = Mf.MF_MT_FRAME_RATE; a.SetUINT64(ref rate, Mf.Pack2((uint)_fps, 1));
            var par = Mf.MF_MT_PIXEL_ASPECT_RATIO; a.SetUINT64(ref par, Mf.Pack2(1, 1));
            var il = Mf.MF_MT_INTERLACE_MODE; a.SetUINT32(ref il, Mf.MFVideoInterlace_Progressive);
            // Constrained Baseline matches the profile-level-id=42e01f we put in
            // the SDP. Advertising Main here while offering 42e01f is how you get
            // a browser that negotiates happily and then shows nothing.
            var prof = Mf.MF_MT_MPEG2_PROFILE; a.SetUINT32(ref prof, Mf.eAVEncH264VProfile_Base);
            return true;
        }
        finally { try { Marshal.ReleaseComObject(a); } catch { } }
    }

    private bool BuildInputType(out IntPtr type)
    {
        type = IntPtr.Zero;
        if (Mf.MFCreateMediaType(out type) < 0 || type == IntPtr.Zero) { Fail("MFCreateMediaType (input)"); return false; }
        if (Marshal.GetObjectForIUnknown(type) is not Mf.IMFAttributes a) { Fail("input type QI"); return false; }
        try
        {
            var major = Mf.MF_MT_MAJOR_TYPE; var video = Mf.MFMediaType_Video;
            a.SetGUID(ref major, ref video);
            var sub = Mf.MF_MT_SUBTYPE; var nv12 = Mf.MFVideoFormat_NV12;
            a.SetGUID(ref sub, ref nv12);
            var size = Mf.MF_MT_FRAME_SIZE; a.SetUINT64(ref size, Mf.Pack2((uint)_width, (uint)_height));
            var rate = Mf.MF_MT_FRAME_RATE; a.SetUINT64(ref rate, Mf.Pack2((uint)_fps, 1));
            var par = Mf.MF_MT_PIXEL_ASPECT_RATIO; a.SetUINT64(ref par, Mf.Pack2(1, 1));
            var il = Mf.MF_MT_INTERLACE_MODE; a.SetUINT32(ref il, Mf.MFVideoInterlace_Progressive);
            return true;
        }
        finally { try { Marshal.ReleaseComObject(a); } catch { } }
    }

    private static string ReadFriendlyName(Mf.IMFActivate activate)
    {
        IntPtr str = IntPtr.Zero;
        try
        {
            var key = Mf.MFT_FRIENDLY_NAME_Attribute;
            if (activate.GetAllocatedString(ref key, out str, out _) < 0 || str == IntPtr.Zero) return "";
            return Marshal.PtrToStringUni(str) ?? "";
        }
        catch { return ""; }
        finally { if (str != IntPtr.Zero) Marshal.FreeCoTaskMem(str); }
    }

    // ---- public surface -----------------------------------------------------

    /// <summary>
    /// Encode one BGRA frame. Returns the Annex-B access unit, or null when the
    /// encoder produced nothing for this input (normal on the first frames of
    /// a pipelined hardware encoder) or when it has died.
    /// </summary>
    public byte[]? Encode(byte[] bgra, int width, int height, out bool geometryChanged)
    {
        geometryChanged = false;
        if (_dead) return null;

        lock (_gate)
        {
            if (_dead) return null;
            if (width != _width || height != _height)
            {
                geometryChanged = true;
                return null;
            }
            try
            {
                ConvertBgraToNv12(bgra, width, height);
                IntPtr sample = BuildInputSample();
                if (sample == IntPtr.Zero) return null;

                _accessUnit.Clear();
                bool ok = _async ? DriveAsync(sample) : DriveSync(sample);
                if (!ok) return null;
                return _accessUnit.Count > 0 ? _accessUnit.ToArray() : null;
            }
            catch (Exception ex)
            {
                Fail("encode threw: " + ex.Message);
                return null;
            }
        }
    }

    /// <summary>Ask the encoder for an IDR on the next frame (PLI/FIR handling).</summary>
    public void ForceKeyFrame()
    {
        if (_dead) return;
        Mf.TrySetCodecApi(_codecApi, Mf.CODECAPI_AVEncVideoForceKeyFrame, Mf.PropVariant.FromUInt32(1));
    }

    /// <summary>
    /// Re-target the encoder's bitrate when the ladder moves. Resolution changes
    /// are NOT handled here — those rebuild the encoder (see
    /// <see cref="Encode"/>'s geometryChanged flag).
    /// </summary>
    public void SetBitrateKbps(int kbps)
    {
        if (_dead) return;
        int bps = Math.Clamp(kbps, 200, 40000) * 1000;
        if (bps == _bitrateBps) return;
        _bitrateBps = bps;
        Mf.TrySetCodecApi(_codecApi, Mf.CODECAPI_AVEncCommonMeanBitRate, Mf.PropVariant.FromUInt32((uint)bps));
    }

    // ---- MFT drive ----------------------------------------------------------

    private bool DriveSync(IntPtr sample)
    {
        var mft = _mft!;
        try
        {
            int hr = mft.ProcessInput(0, sample, 0);
            if (hr == Mf.MF_E_NOTACCEPTING)
            {
                // Encoder still holds the previous frame: drain first, then retry
                // once. Dropping here would stall the stream on slow silicon.
                CollectOutputs();
                hr = mft.ProcessInput(0, sample, 0);
            }
            if (hr < 0) { Fail($"ProcessInput 0x{hr:X8}"); return false; }
        }
        finally { Marshal.Release(sample); }

        CollectOutputs();
        return !_dead;
    }

    private bool DriveAsync(IntPtr sample)
    {
        var mft = _mft!;
        var events = _events!;
        bool fed = false;
        bool producedOutput = false;
        // Bounded pump. A hardware encoder answers in single-digit milliseconds;
        // anything past this is a wedged driver and we would rather skip the
        // frame than block the capture tee.
        long deadline = Environment.TickCount64 + 120;

        try
        {
            while (Environment.TickCount64 < deadline && !_dead)
            {
                // Feed this frame the instant the encoder has an outstanding
                // input request. Credits persist across calls, so one banked on
                // a previous frame lets us submit immediately with no wait.
                if (!fed && _pendingInputCredits > 0)
                {
                    int ih = mft.ProcessInput(0, sample, 0);
                    if (ih >= 0) { _pendingInputCredits--; fed = true; continue; }
                    if (ih != Mf.MF_E_NOTACCEPTING) { Fail($"ProcessInput 0x{ih:X8}"); return false; }
                    // NOTACCEPTING: the encoder is holding output; fall through to
                    // drain an event, then retry the feed on the next iteration.
                }

                // Our frame is in and its access unit collected. Stop here and
                // leave any further outputs for the next call, so each access
                // unit keeps its own RTP timestamp instead of being concatenated.
                if (fed && producedOutput) break;

                int hr = events.GetEvent(Mf.MF_EVENT_FLAG_NO_WAIT, out var evt);
                if (hr == Mf.MF_E_NO_EVENTS_AVAILABLE)
                {
                    Thread.Sleep(1); // yield a tick instead of busy-spinning on Sleep(0)
                    continue;
                }
                if (hr < 0 || evt == null) { Fail($"GetEvent 0x{hr:X8}"); return false; }

                uint met;
                try { if (evt.GetType(out met) < 0) continue; }
                finally { try { Marshal.ReleaseComObject(evt); } catch { } }

                if (met == Mf.METransformNeedInput)
                {
                    if (_pendingInputCredits < 8) _pendingInputCredits++;
                    // If our frame is already in, the encoder asking for the next
                    // one means it is done with ours: its output (if any) was
                    // collected above, so stop rather than wait out the deadline
                    // on a pipeline-warmup frame that will never emit output.
                    if (fed) break;
                }
                else if (met == Mf.METransformHaveOutput)
                {
                    if (!CollectOneOutput()) return false;
                    if (!_lastOutputWasEmpty) producedOutput = true;
                }
            }
        }
        finally { Marshal.Release(sample); }

        // Not delivering is not fatal — the frame is simply skipped and the next
        // one will find the encoder ready (with a banked credit).
        return !_dead;
    }

    private void CollectOutputs()
    {
        // Synchronous MFTs answer NEED_MORE_INPUT once they are drained; that is
        // the loop's exit condition, not an error.
        for (int i = 0; i < 16; i++)
        {
            if (!CollectOneOutput()) return;
            if (_lastOutputWasEmpty) return;
        }
    }

    private bool _lastOutputWasEmpty;

    private bool CollectOneOutput()
    {
        _lastOutputWasEmpty = true;
        var mft = _mft!;

        IntPtr allocated = IntPtr.Zero;
        var buffers = new Mf.MFT_OUTPUT_DATA_BUFFER { dwStreamID = 0 };

        if (!_outputProvidesSamples)
        {
            if (Mf.MFCreateSample(out allocated) < 0 || allocated == IntPtr.Zero) return false;
            if (Mf.MFCreateMemoryBuffer(Math.Max(_outputBufferSize, 64 * 1024), out IntPtr buf) < 0)
            {
                Marshal.Release(allocated);
                return false;
            }
            try
            {
                if (Marshal.GetObjectForIUnknown(allocated) is Mf.IMFSample s &&
                    Marshal.GetObjectForIUnknown(buf) is Mf.IMFMediaBuffer b)
                {
                    s.AddBuffer(b);
                    try { Marshal.ReleaseComObject(b); } catch { }
                    try { Marshal.ReleaseComObject(s); } catch { }
                }
            }
            finally { Marshal.Release(buf); }
            buffers.pSample = allocated;
        }

        int hr = mft.ProcessOutput(0, 1, ref buffers, out _);

        if (hr == Mf.MF_E_TRANSFORM_NEED_MORE_INPUT)
        {
            if (allocated != IntPtr.Zero) Marshal.Release(allocated);
            return true;
        }
        if (hr == Mf.MF_E_TRANSFORM_STREAM_CHANGE)
        {
            if (allocated != IntPtr.Zero) Marshal.Release(allocated);
            if (!RenegotiateOutput()) return false;
            return true;
        }
        if (hr < 0)
        {
            if (allocated != IntPtr.Zero) Marshal.Release(allocated);
            Fail($"ProcessOutput 0x{hr:X8}");
            return false;
        }

        IntPtr outSample = buffers.pSample;
        if (outSample != IntPtr.Zero)
        {
            try { AppendSample(outSample); }
            finally { Marshal.Release(outSample); }
            _lastOutputWasEmpty = false;
        }
        if (buffers.pEvents != IntPtr.Zero) Marshal.Release(buffers.pEvents);
        return true;
    }

    private void AppendSample(IntPtr samplePtr)
    {
        if (Marshal.GetObjectForIUnknown(samplePtr) is not Mf.IMFSample sample) return;
        try
        {
            if (sample.ConvertToContiguousBuffer(out var buffer) < 0 || buffer == null) return;
            try
            {
                if (buffer.Lock(out IntPtr p, out _, out uint len) < 0 || p == IntPtr.Zero || len == 0) return;
                try
                {
                    // The MFT emits Annex-B (start-code prefixed) NAL units for
                    // the MFVideoFormat_H264 output subtype, which is exactly what
                    // SIPSorcery's H264Packetiser parses. No conversion needed.
                    var tmp = new byte[len];
                    Marshal.Copy(p, tmp, 0, (int)len);
                    _accessUnit.AddRange(tmp);
                }
                finally { buffer.Unlock(); }
            }
            finally { try { Marshal.ReleaseComObject(buffer); } catch { } }
        }
        finally { try { Marshal.ReleaseComObject(sample); } catch { } }
    }

    private bool RenegotiateOutput()
    {
        var mft = _mft!;
        // The driver changed its mind about the output type (common on the first
        // frame). Take its own preferred type verbatim rather than re-asserting
        // ours — arguing with it here is how encoders end up emitting nothing.
        for (uint i = 0; i < 8; i++)
        {
            IntPtr candidate = IntPtr.Zero;
            int hr = mft.GetOutputAvailableType(0, i, out candidate);
            if (hr == Mf.MF_E_NO_MORE_TYPES || hr < 0 || candidate == IntPtr.Zero) break;
            try
            {
                if (mft.SetOutputType(0, candidate, 0) >= 0)
                {
                    if (mft.GetOutputStreamInfo(0, out var info) >= 0)
                    {
                        _outputProvidesSamples =
                            (info.dwFlags & (Mf.MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | Mf.MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
                        _outputBufferSize = Math.Max(info.cbSize, (uint)(_width * _height));
                    }
                    return true;
                }
            }
            finally { Marshal.Release(candidate); }
        }
        Fail("output stream change could not be renegotiated");
        return false;
    }

    private IntPtr BuildInputSample()
    {
        int ySize = _width * _height;
        int total = ySize + ySize / 2;

        if (Mf.MFCreateMemoryBuffer((uint)total, out IntPtr bufPtr) < 0 || bufPtr == IntPtr.Zero) return IntPtr.Zero;
        try
        {
            if (Marshal.GetObjectForIUnknown(bufPtr) is not Mf.IMFMediaBuffer buffer) return IntPtr.Zero;
            try
            {
                if (buffer.Lock(out IntPtr dst, out _, out _) < 0 || dst == IntPtr.Zero) return IntPtr.Zero;
                try { Marshal.Copy(_nv12!, 0, dst, total); }
                finally { buffer.Unlock(); }
                buffer.SetCurrentLength((uint)total);

                if (Mf.MFCreateSample(out IntPtr samplePtr) < 0 || samplePtr == IntPtr.Zero) return IntPtr.Zero;
                if (Marshal.GetObjectForIUnknown(samplePtr) is not Mf.IMFSample sample)
                {
                    Marshal.Release(samplePtr);
                    return IntPtr.Zero;
                }
                try
                {
                    sample.AddBuffer(buffer);
                    // 100-ns units. A monotonic frame index keeps the encoder's
                    // rate control honest even when capture cadence jitters.
                    long duration = 10_000_000L / _fps;
                    sample.SetSampleTime(_frameIndex * duration);
                    sample.SetSampleDuration(duration);
                    _frameIndex++;
                }
                finally { try { Marshal.ReleaseComObject(sample); } catch { } }
                return samplePtr;   // caller releases
            }
            finally { try { Marshal.ReleaseComObject(buffer); } catch { } }
        }
        finally { Marshal.Release(bufPtr); }
    }

    private void Send(uint message)
    {
        try { _mft?.ProcessMessage(message, IntPtr.Zero); } catch { }
    }

    private void Fail(string reason)
    {
        if (_dead) return;
        _dead = true;
        _deadReason = reason;
        Log.Warn($"h264: encoder retired — {reason}; falling back to software VP8");
    }

    // ---- colour conversion --------------------------------------------------

    /// <summary>
    /// BGRA32 → NV12, BT.601 limited range. The admin's <c>FrameConvert</c>
    /// decodes with the matching 298/409/516 coefficients, so these two must
    /// stay in step or every session comes back washed out.
    /// </summary>
    private unsafe void ConvertBgraToNv12(byte[] bgra, int width, int height)
    {
        int ySize = width * height;
        int total = ySize + ySize / 2;
        if (_nv12 == null || _nv12.Length != total) _nv12 = new byte[total];

        fixed (byte* srcBase = bgra)
        fixed (byte* dstBase = _nv12)
        {
            byte* yPlane = dstBase;
            byte* uvPlane = dstBase + ySize;

            for (int y = 0; y < height; y++)
            {
                byte* row = srcBase + (long)y * width * 4;
                byte* yOut = yPlane + (long)y * width;
                for (int x = 0; x < width; x++)
                {
                    int b = row[x * 4 + 0];
                    int g = row[x * 4 + 1];
                    int r = row[x * 4 + 2];
                    yOut[x] = (byte)(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
                }
            }

            // 2x2 box average for chroma — cheap, and visually indistinguishable
            // from a proper filter at desktop content densities.
            for (int y = 0; y < height; y += 2)
            {
                byte* row0 = srcBase + (long)y * width * 4;
                byte* row1 = srcBase + (long)Math.Min(y + 1, height - 1) * width * 4;
                byte* uvOut = uvPlane + (long)(y / 2) * width;
                for (int x = 0; x < width; x += 2)
                {
                    int x1 = Math.Min(x + 1, width - 1);
                    int b = (row0[x * 4 + 0] + row0[x1 * 4 + 0] + row1[x * 4 + 0] + row1[x1 * 4 + 0]) >> 2;
                    int g = (row0[x * 4 + 1] + row0[x1 * 4 + 1] + row1[x * 4 + 1] + row1[x1 * 4 + 1]) >> 2;
                    int r = (row0[x * 4 + 2] + row0[x1 * 4 + 2] + row1[x * 4 + 2] + row1[x1 * 4 + 2]) >> 2;

                    int u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                    int v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                    uvOut[x + 0] = (byte)Math.Clamp(u, 0, 255);
                    uvOut[x + 1] = (byte)Math.Clamp(v, 0, 255);
                }
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_mft != null)
            {
                Send(Mf.MFT_MESSAGE_COMMAND_FLUSH);
                Send(Mf.MFT_MESSAGE_NOTIFY_END_OF_STREAM);
                Send(Mf.MFT_MESSAGE_NOTIFY_END_STREAMING);
                try { Marshal.ReleaseComObject(_mft); } catch { }
                _mft = null;
            }
            _events = null;
            _codecApi = null;
            _nv12 = null;
            _accessUnit.Clear();
        }
    }
}
