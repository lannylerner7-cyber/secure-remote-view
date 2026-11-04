using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Brain-engine phase 1 (admin side) — H.264 decode through Media Foundation.
///
/// The agent can now encode the desktop with the machine's own hardware
/// encoder. This is the matching half: the native console has to be able to
/// decode what it asked for, or negotiating H.264 would hand the technician a
/// connected session with a black picture.
///
/// Contract kept deliberately narrow so <see cref="VideoPipeline"/> barely
/// changes: Annex-B access unit in, tightly packed NV12 out. The pipeline's
/// existing <c>FrameConvert</c> already turns NV12 into the BGRA32 the
/// presenter wants, using the same BT.601 coefficients the agent encodes with.
///
/// Every failure path returns false/null. A machine whose Media Foundation
/// cannot do this simply never advertises H.264, and the session runs on VP8
/// exactly as it does today.
/// </summary>
public sealed class H264Decoder : IDisposable
{
    private static readonly Guid IID_IMFTransform = new("bf94c121-5b05-4e6f-8000-ba598961414d");

    private readonly object _gate = new();
    private Mf.IMFTransform? _mft;
    private Mf.IMFMediaEventGenerator? _events;
    private bool _async;
    private bool _outputProvidesSamples;
    private uint _outputBufferSize;
    private bool _dead;
    private long _frameIndex;

    // _width/_height are the decoder's coded size (macroblock aligned, so
    // 1920x1088 for a 1080p stream); _displayW/_displayH are the visible
    // picture inside it. Planes are laid out by the coded size, but only the
    // visible part is handed on, or the padding rows show up as a junk strip
    // along the bottom edge.
    private int _width, _height, _stride;
    private int _displayW, _displayH;
    private byte[]? _nv12;

    // MF_MT_MINIMUM_DISPLAY_APERTURE / MF_MT_GEOM_APERTURE (MFVideoArea blobs).
    // Kept here rather than in MediaFoundationInterop.cs, which is shared
    // byte-for-byte with the agent.
    private static readonly Guid MinimumDisplayAperture = new("d7388766-18fe-48c6-a177-ee894867c8c4");
    private static readonly Guid GeometricAperture = new("66758743-7e5f-400d-980a-aa8596c85696");

    /// <summary>Visible width of the last decoded picture, or 0 before the first one.</summary>
    public int Width => _displayW;

    /// <summary>Visible height of the last decoded picture, or 0 before the first one.</summary>
    public int Height => _displayH;

    /// <summary>False once the decoder has failed; the caller must retire the H.264 path.</summary>
    public bool IsAlive => !_dead;

    /// <summary>Why the decoder retired, or "" while healthy.</summary>
    public string DeadReason { get; private set; } = "";

    private H264Decoder() { }

    /// <summary>Build a decoder, or return null when this machine cannot decode H.264.</summary>
    public static H264Decoder? TryCreate()
    {
        var dec = new H264Decoder();
        try
        {
            if (dec.Initialise()) return dec;
        }
        catch (Exception ex)
        {
            dec.DeadReason = ex.Message;
        }
        dec.Dispose();
        return null;
    }

    private bool Initialise()
    {
        if (!Mf.EnsureStarted()) return false;

        var inInfo = new Mf.MFT_REGISTER_TYPE_INFO
        {
            guidMajorType = Mf.MFMediaType_Video,
            guidSubtype = Mf.MFVideoFormat_H264,
        };
        IntPtr inPtr = Marshal.AllocHGlobal(Marshal.SizeOf<Mf.MFT_REGISTER_TYPE_INFO>());
        Marshal.StructureToPtr(inInfo, inPtr, false);
        IntPtr activateArray = IntPtr.Zero;

        try
        {
            // Hardware first (SORTANDFILTER puts the best candidate at index 0),
            // but the Microsoft software decoder is an entirely acceptable
            // fallback here: decoding 1080p/4K H.264 in software costs far less
            // than the VP8 decode it replaces.
            const uint flags = Mf.MFT_ENUM_FLAG_HARDWARE |
                               Mf.MFT_ENUM_FLAG_SYNCMFT |
                               Mf.MFT_ENUM_FLAG_ASYNCMFT |
                               Mf.MFT_ENUM_FLAG_SORTANDFILTER;

            int hr = Mf.MFTEnumEx(Mf.MFT_CATEGORY_VIDEO_DECODER, flags,
                                  inPtr, IntPtr.Zero, out activateArray, out uint count);
            if (hr < 0 || count == 0) return false;

            for (uint i = 0; i < count && _mft == null; i++)
            {
                IntPtr unk = Marshal.ReadIntPtr(activateArray, (int)i * IntPtr.Size);
                if (unk == IntPtr.Zero) continue;
                object? activateObj = null;
                try
                {
                    activateObj = Marshal.GetObjectForIUnknown(unk);
                    if (activateObj is not Mf.IMFActivate activate) continue;
                    var iid = IID_IMFTransform;
                    if (activate.ActivateObject(ref iid, out IntPtr tp) < 0 || tp == IntPtr.Zero) continue;
                    try
                    {
                        if (Marshal.GetObjectForIUnknown(tp) is Mf.IMFTransform t) _mft = t;
                    }
                    finally { Marshal.Release(tp); }
                }
                catch { }
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
            Marshal.FreeHGlobal(inPtr);
        }

        if (_mft == null) return false;
        if (!Configure()) return false;

        Send(Mf.MFT_MESSAGE_NOTIFY_BEGIN_STREAMING);
        Send(Mf.MFT_MESSAGE_NOTIFY_START_OF_STREAM);
        return true;
    }

    private bool Configure()
    {
        var mft = _mft!;

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
                var low = Mf.MF_LOW_LATENCY;
                attrs.SetUINT32(ref low, 1);
            }
            finally { try { Marshal.ReleaseComObject(attrs); } catch { } }
        }
        if (_async)
        {
            _events = mft as Mf.IMFMediaEventGenerator;
            if (_events == null) return false;
        }

        // Input first for a decoder (the mirror image of the encoder). Frame
        // size is a placeholder: the real geometry arrives in the bitstream's
        // SPS and the MFT tells us via MF_E_TRANSFORM_STREAM_CHANGE.
        if (Mf.MFCreateMediaType(out IntPtr inType) < 0 || inType == IntPtr.Zero) return false;
        try
        {
            if (Marshal.GetObjectForIUnknown(inType) is not Mf.IMFAttributes a) return false;
            try
            {
                var major = Mf.MF_MT_MAJOR_TYPE; var video = Mf.MFMediaType_Video;
                a.SetGUID(ref major, ref video);
                var sub = Mf.MF_MT_SUBTYPE; var h264 = Mf.MFVideoFormat_H264;
                a.SetGUID(ref sub, ref h264);
                var il = Mf.MF_MT_INTERLACE_MODE; a.SetUINT32(ref il, Mf.MFVideoInterlace_Progressive);
                var rate = Mf.MF_MT_FRAME_RATE; a.SetUINT64(ref rate, Mf.Pack2(30, 1));
            }
            finally { try { Marshal.ReleaseComObject(a); } catch { } }

            if (mft.SetInputType(0, inType, 0) < 0) return false;
        }
        finally { Marshal.Release(inType); }

        return SelectNv12Output();
    }

    /// <summary>Pick the decoder's NV12 output type and remember its stride.</summary>
    private bool SelectNv12Output()
    {
        var mft = _mft!;
        for (uint i = 0; i < 16; i++)
        {
            if (mft.GetOutputAvailableType(0, i, out IntPtr candidate) < 0 || candidate == IntPtr.Zero) break;
            try
            {
                if (Marshal.GetObjectForIUnknown(candidate) is not Mf.IMFAttributes a) continue;
                bool isNv12;
                try
                {
                    var sub = Mf.MF_MT_SUBTYPE;
                    isNv12 = a.GetGUID(ref sub, out Guid fmt) >= 0 && fmt == Mf.MFVideoFormat_NV12;
                    if (isNv12 && mft.SetOutputType(0, candidate, 0) >= 0)
                    {
                        var size = Mf.MF_MT_FRAME_SIZE;
                        if (a.GetUINT64(ref size, out ulong packed) >= 0)
                        {
                            Mf.Unpack2(packed, out uint w, out uint h);
                            _width = (int)w; _height = (int)h;
                        }
                        var strideKey = Mf.MF_MT_DEFAULT_STRIDE;
                        _stride = a.GetUINT32(ref strideKey, out uint st) >= 0 && st > 0 ? (int)st : _width;
                        ReadDisplayArea(a);

                        if (mft.GetOutputStreamInfo(0, out var info) >= 0)
                        {
                            _outputProvidesSamples =
                                (info.dwFlags & (Mf.MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | Mf.MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
                            _outputBufferSize = Math.Max(info.cbSize, (uint)Math.Max(1, _width * _height * 3 / 2));
                        }
                        return true;
                    }
                }
                finally { try { Marshal.ReleaseComObject(a); } catch { } }
            }
            finally { Marshal.Release(candidate); }
        }
        return false;
    }

    /// <summary>
    /// Decode one Annex-B access unit. Returns a tightly packed NV12 buffer for
    /// <paramref name="width"/> x <paramref name="height"/>, or null when the
    /// decoder produced no picture for this input — normal while it is filling
    /// its reference pipeline, and normal for a stream that starts mid-GOP.
    /// </summary>
    public byte[]? Decode(byte[] annexB, out int width, out int height)
    {
        width = _displayW; height = _displayH;
        if (_dead || annexB == null || annexB.Length == 0) return null;

        lock (_gate)
        {
            if (_dead) return null;
            try
            {
                IntPtr sample = BuildSample(annexB);
                if (sample == IntPtr.Zero) return null;

                byte[]? picture;
                try
                {
                    picture = _async ? DriveAsync(sample) : DriveSync(sample);
                }
                finally { Marshal.Release(sample); }

                width = _displayW; height = _displayH;
                return picture;
            }
            catch (Exception ex)
            {
                Fail("decode threw: " + ex.Message);
                return null;
            }
        }
    }

    private byte[]? DriveSync(IntPtr sample)
    {
        var mft = _mft!;
        int hr = mft.ProcessInput(0, sample, 0);
        if (hr == Mf.MF_E_NOTACCEPTING)
        {
            var pending = Collect();
            mft.ProcessInput(0, sample, 0);
            return pending ?? Collect();
        }
        if (hr < 0) { Fail($"ProcessInput 0x{hr:X8}"); return null; }
        return Collect();
    }

    private byte[]? DriveAsync(IntPtr sample)
    {
        var mft = _mft!;
        var events = _events!;
        bool delivered = false;
        byte[]? picture = null;
        long deadline = Environment.TickCount64 + 120;

        while (Environment.TickCount64 < deadline)
        {
            int hr = events.GetEvent(Mf.MF_EVENT_FLAG_NO_WAIT, out var evt);
            if (hr == Mf.MF_E_NO_EVENTS_AVAILABLE)
            {
                if (delivered && picture != null) break;
                Thread.Sleep(0);
                continue;
            }
            if (hr < 0 || evt == null) { Fail($"GetEvent 0x{hr:X8}"); return null; }

            uint met = 0;
            try { if (evt.GetType(out met) < 0) continue; }
            finally { try { Marshal.ReleaseComObject(evt); } catch { } }

            if (met == Mf.METransformNeedInput)
            {
                if (delivered) break;                 // wants the next access unit
                int ih = mft.ProcessInput(0, sample, 0);
                if (ih < 0 && ih != Mf.MF_E_NOTACCEPTING) { Fail($"ProcessInput 0x{ih:X8}"); return null; }
                delivered = ih >= 0;
            }
            else if (met == Mf.METransformHaveOutput)
            {
                picture = Collect() ?? picture;
                if (delivered) break;
            }
        }
        return picture;
    }

    private byte[]? Collect()
    {
        var mft = _mft!;
        IntPtr allocated = IntPtr.Zero;
        var buffers = new Mf.MFT_OUTPUT_DATA_BUFFER { dwStreamID = 0 };

        if (!_outputProvidesSamples)
        {
            if (Mf.MFCreateSample(out allocated) < 0 || allocated == IntPtr.Zero) return null;
            if (Mf.MFCreateMemoryBuffer(Math.Max(_outputBufferSize, 64 * 1024), out IntPtr buf) < 0)
            {
                Marshal.Release(allocated);
                return null;
            }
            try
            {
                if (Marshal.GetObjectForIUnknown(allocated) is Mf.IMFSample s)
                {
                    if (Marshal.GetObjectForIUnknown(buf) is Mf.IMFMediaBuffer b)
                    {
                        s.AddBuffer(b);
                        try { Marshal.ReleaseComObject(b); } catch { }
                    }
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
            return null;
        }
        if (hr == Mf.MF_E_TRANSFORM_STREAM_CHANGE)
        {
            // The SPS told the decoder the real picture size. Re-select the
            // output type and let the next access unit produce the picture.
            if (allocated != IntPtr.Zero) Marshal.Release(allocated);
            if (!SelectNv12Output()) Fail("output stream change could not be renegotiated");
            return null;
        }
        if (hr < 0)
        {
            if (allocated != IntPtr.Zero) Marshal.Release(allocated);
            Fail($"ProcessOutput 0x{hr:X8}");
            return null;
        }

        byte[]? picture = null;
        if (buffers.pSample != IntPtr.Zero)
        {
            try { picture = ReadPicture(buffers.pSample); }
            finally { Marshal.Release(buffers.pSample); }
        }
        if (buffers.pEvents != IntPtr.Zero) Marshal.Release(buffers.pEvents);
        return picture;
    }

    /// <summary>
    /// Visible picture size from the display aperture, falling back to the
    /// coded size. Rounded down to even so the 4:2:0 chroma rows still pair up.
    /// </summary>
    private void ReadDisplayArea(Mf.IMFAttributes a)
    {
        _displayW = _width;
        _displayH = _height;
        foreach (var key in new[] { MinimumDisplayAperture, GeometricAperture })
        {
            var k = key;
            // MFVideoArea: MFOffset OffsetX, MFOffset OffsetY (4 bytes each), SIZE Area (cx, cy).
            IntPtr blob = Marshal.AllocHGlobal(16);
            try
            {
                if (a.GetBlob(ref k, blob, 16, IntPtr.Zero) < 0) continue;
                int cx = Marshal.ReadInt32(blob, 8);
                int cy = Marshal.ReadInt32(blob, 12);
                if (cx <= 0 || cy <= 0 || cx > _width || cy > _height) continue;
                _displayW = cx & ~1;
                _displayH = cy & ~1;
                return;
            }
            finally { Marshal.FreeHGlobal(blob); }
        }
    }

    /// <summary>
    /// Copy the decoder's NV12 output into a tightly packed buffer. The MFT's
    /// rows are stride-aligned; handing the padded buffer straight to the
    /// converter is what produces a sheared picture, so rows are copied one at
    /// a time whenever stride and width disagree.
    /// </summary>
    private byte[]? ReadPicture(IntPtr samplePtr)
    {
        if (Marshal.GetObjectForIUnknown(samplePtr) is not Mf.IMFSample sample) return null;
        try
        {
            if (sample.ConvertToContiguousBuffer(out var buffer) < 0 || buffer == null) return null;
            try
            {
                if (buffer.Lock(out IntPtr src, out _, out uint len) < 0 || src == IntPtr.Zero || len == 0) return null;
                try
                {
                    int w = _displayW, h = _displayH, codedH = _height;
                    if (w <= 0 || h <= 0 || codedH < h) return null;
                    int stride = _stride > 0 ? _stride : _width;
                    int needed = w * h * 3 / 2;
                    if (_nv12 == null || _nv12.Length != needed) _nv12 = new byte[needed];

                    if (stride == w && codedH == h && len >= needed)
                    {
                        Marshal.Copy(src, _nv12, 0, needed);
                    }
                    else
                    {
                        // The UV plane starts after the full coded luma plane,
                        // not after the visible rows.
                        long required = (long)stride * codedH + (long)stride * (h / 2);
                        if (len < required) return null;
                        for (int y = 0; y < h; y++)
                            Marshal.Copy(src + y * stride, _nv12, y * w, w);
                        int uvBase = w * h;
                        int uvSrc = stride * codedH;
                        for (int y = 0; y < h / 2; y++)
                            Marshal.Copy(src + uvSrc + y * stride, _nv12, uvBase + y * w, w);
                    }
                    _frameIndex++;
                    return _nv12;
                }
                finally { buffer.Unlock(); }
            }
            finally { try { Marshal.ReleaseComObject(buffer); } catch { } }
        }
        finally { try { Marshal.ReleaseComObject(sample); } catch { } }
    }

    private IntPtr BuildSample(byte[] annexB)
    {
        if (Mf.MFCreateMemoryBuffer((uint)annexB.Length, out IntPtr bufPtr) < 0 || bufPtr == IntPtr.Zero) return IntPtr.Zero;
        try
        {
            if (Marshal.GetObjectForIUnknown(bufPtr) is not Mf.IMFMediaBuffer buffer) return IntPtr.Zero;
            try
            {
                if (buffer.Lock(out IntPtr dst, out _, out _) < 0 || dst == IntPtr.Zero) return IntPtr.Zero;
                try { Marshal.Copy(annexB, 0, dst, annexB.Length); }
                finally { buffer.Unlock(); }
                buffer.SetCurrentLength((uint)annexB.Length);

                if (Mf.MFCreateSample(out IntPtr samplePtr) < 0 || samplePtr == IntPtr.Zero) return IntPtr.Zero;
                if (Marshal.GetObjectForIUnknown(samplePtr) is not Mf.IMFSample sample)
                {
                    Marshal.Release(samplePtr);
                    return IntPtr.Zero;
                }
                try
                {
                    sample.AddBuffer(buffer);
                    long duration = 10_000_000L / 30;
                    sample.SetSampleTime(_frameIndex * duration);
                    sample.SetSampleDuration(duration);
                }
                finally { try { Marshal.ReleaseComObject(sample); } catch { } }
                return samplePtr;
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
        DeadReason = reason;
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
            _nv12 = null;
        }
    }
}
