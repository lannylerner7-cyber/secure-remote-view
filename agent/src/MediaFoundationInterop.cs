using System;
using System.Runtime.InteropServices;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:CAPTURE — raw Media Foundation COM interop shared by the hardware
/// H.264 encoder path.
///
/// Everything here is hand-written P/Invoke and hand-ordered COM vtables. That
/// is deliberate: the agent publishes as a single self-contained file, so a
/// native interop package (SharpDX.MediaFoundation and friends) would either
/// break the publish contract or drag a payload we cannot sign. mfplat.dll and
/// mfuuid are already on every supported Windows build.
///
/// RULES FOR EDITING THIS FILE:
///   • COM dispatch is by vtable slot. Every method of every interface below
///     is declared in exact IDL order, including ones we never call. Deleting
///     an "unused" declaration silently shifts every method after it onto the
///     wrong slot and corrupts memory. Do not tidy them away.
///   • Every entry point is [PreserveSig]: MF reports normal control flow
///     (NEED_MORE_INPUT, STREAM_CHANGE) as failure HRESULTs, and letting the
///     CLR turn those into exceptions would make the encode loop unwritable.
/// </summary>
internal static class Mf
{
    // ---- HRESULTs that are control flow, not errors -----------------------

    public const int S_OK = 0;
    public const int MF_E_TRANSFORM_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);
    public const int MF_E_TRANSFORM_STREAM_CHANGE = unchecked((int)0xC00D6D61);
    public const int MF_E_NO_MORE_TYPES = unchecked((int)0xC00D36B9);
    public const int MF_E_NO_EVENTS_AVAILABLE = unchecked((int)0xC00D3E80);
    public const int MF_E_INVALIDMEDIATYPE = unchecked((int)0xC00D36B4);
    public const int MF_E_NOTACCEPTING = unchecked((int)0xC00D36B5);

    // ---- Startup ----------------------------------------------------------

    public const uint MF_VERSION = 0x00020070;
    public const uint MFSTARTUP_NOSOCKET = 1;

    private static readonly object _initGate = new();
    private static bool _started;

    /// <summary>
    /// Idempotent MFStartup. The probe already starts and shuts MF down around
    /// its enumeration; the encoder needs the platform to stay up for the life
    /// of the session, so it owns a separate, never-shut-down reference.
    /// </summary>
    public static bool EnsureStarted()
    {
        lock (_initGate)
        {
            if (_started) return true;
            int hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
            if (hr < 0) return false;
            _started = true;
            return true;
        }
    }

    // ---- MFT enumeration / activation --------------------------------------

    public const uint MFT_ENUM_FLAG_SYNCMFT = 0x00000001;
    public const uint MFT_ENUM_FLAG_ASYNCMFT = 0x00000002;
    public const uint MFT_ENUM_FLAG_HARDWARE = 0x00000004;
    public const uint MFT_ENUM_FLAG_SORTANDFILTER = 0x00000040;

    public static readonly Guid MFT_CATEGORY_VIDEO_ENCODER = new("f79eac7d-e545-4387-bdee-d647d7bde42a");
    public static readonly Guid MFT_CATEGORY_VIDEO_DECODER = new("d6c02d4b-6833-45b4-971a-05a4b04bab91");

    public static readonly Guid MFMediaType_Video = new("73646976-0000-0010-8000-00aa00389b71");
    public static readonly Guid MFVideoFormat_H264 = new("34363248-0000-0010-8000-00aa00389b71");
    public static readonly Guid MFVideoFormat_NV12 = new("3231564e-0000-0010-8000-00aa00389b71");

    // ---- Media type attribute keys ----------------------------------------

    public static readonly Guid MF_MT_MAJOR_TYPE = new("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    public static readonly Guid MF_MT_SUBTYPE = new("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    public static readonly Guid MF_MT_AVG_BITRATE = new("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
    public static readonly Guid MF_MT_FRAME_SIZE = new("1652c33d-d6b2-4012-b834-72030849a37d");
    public static readonly Guid MF_MT_FRAME_RATE = new("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    public static readonly Guid MF_MT_PIXEL_ASPECT_RATIO = new("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    public static readonly Guid MF_MT_INTERLACE_MODE = new("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    public static readonly Guid MF_MT_MPEG2_PROFILE = new("ad76a80b-2d5c-4e0b-b375-64e520137036");
    public static readonly Guid MF_MT_DEFAULT_STRIDE = new("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
    public static readonly Guid MF_MT_ALL_SAMPLES_INDEPENDENT = new("c9173739-5e56-461c-b713-46fb995cb95f");

    public const uint MFVideoInterlace_Progressive = 2;
    public const uint eAVEncH264VProfile_Base = 66;
    public const uint eAVEncH264VProfile_Main = 77;

    // ---- Transform attributes ---------------------------------------------

    public static readonly Guid MF_TRANSFORM_ASYNC = new("f81a699a-649a-497d-8c73-29f8fed6ad7a");
    public static readonly Guid MF_TRANSFORM_ASYNC_UNLOCK = new("e5666d6b-3422-4eb6-a421-da7db1f8e207");
    public static readonly Guid MF_LOW_LATENCY = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    public static readonly Guid MF_SA_D3D11_AWARE = new("206b4fc8-fcf9-4c51-afe3-9764369e33a0");
    public static readonly Guid MFT_FRIENDLY_NAME_Attribute = new("314ffbae-5b41-4c95-9c19-4e7d586face3");

    // ---- Codec API keys ----------------------------------------------------

    public static readonly Guid CODECAPI_AVEncCommonRateControlMode = new("1c0608e9-370c-4710-8a58-cb6181c42423");
    public static readonly Guid CODECAPI_AVEncCommonMeanBitRate = new("f7222374-2144-4815-b550-a37f8e12ee52");
    public static readonly Guid CODECAPI_AVEncCommonQualityVsSpeed = new("98332df8-03cd-476b-89fa-3f9e442dec9f");
    public static readonly Guid CODECAPI_AVEncMPVGOPSize = new("95f31b26-95a4-41aa-9303-246a7fc6eef1");
    public static readonly Guid CODECAPI_AVEncVideoForceKeyFrame = new("398c1b98-8353-475a-9ef2-8f265d260345");
    public static readonly Guid CODECAPI_AVLowLatencyMode = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");

    public const uint eAVEncCommonRateControlMode_CBR = 0;

    // ---- MFT messages / events ---------------------------------------------

    public const uint MFT_MESSAGE_COMMAND_FLUSH = 0x00000000;
    public const uint MFT_MESSAGE_COMMAND_DRAIN = 0x00000001;
    public const uint MFT_MESSAGE_SET_D3D_MANAGER = 0x00000002;
    public const uint MFT_MESSAGE_NOTIFY_BEGIN_STREAMING = 0x10000000;
    public const uint MFT_MESSAGE_NOTIFY_END_STREAMING = 0x10000001;
    public const uint MFT_MESSAGE_NOTIFY_END_OF_STREAM = 0x10000002;
    public const uint MFT_MESSAGE_NOTIFY_START_OF_STREAM = 0x10000003;

    public const uint METransformNeedInput = 601;
    public const uint METransformHaveOutput = 602;
    public const uint METransformDrainComplete = 603;

    public const uint MF_EVENT_FLAG_NO_WAIT = 0x00000001;

    public const uint MFT_OUTPUT_STREAM_PROVIDES_SAMPLES = 0x00000100;
    public const uint MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES = 0x00000200;

    // ---- Structures --------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    public struct MFT_REGISTER_TYPE_INFO
    {
        public Guid guidMajorType;
        public Guid guidSubtype;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MFT_OUTPUT_DATA_BUFFER
    {
        public uint dwStreamID;
        public IntPtr pSample;
        public uint dwStatus;
        public IntPtr pEvents;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MFT_OUTPUT_STREAM_INFO
    {
        public uint dwFlags;
        public uint cbSize;
        public uint cbAlignment;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MFT_INPUT_STREAM_INFO
    {
        public long hnsMaxLatency;
        public uint dwFlags;
        public uint cbSize;
        public uint cbMaxLookahead;
        public uint cbAlignment;
    }

    /// <summary>
    /// Minimal PROPVARIANT. 24 bytes on x64: the 8-byte header, the union, and
    /// the trailing half of the largest union member. Only VT_UI4 / VT_BOOL are
    /// ever written, which live entirely in the first union word.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant
    {
        public ushort vt;
        public ushort r1, r2, r3;
        public long value;
        public long value2;

        public const ushort VT_UI4 = 19;
        public const ushort VT_BOOL = 11;

        public static PropVariant FromUInt32(uint v) => new() { vt = VT_UI4, value = v };
        public static PropVariant FromBool(bool v) => new() { vt = VT_BOOL, value = v ? -1 : 0 };
    }

    // ---- Exports ------------------------------------------------------------

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFStartup(uint version, uint flags);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFShutdown();

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFCreateMediaType(out IntPtr ppMFType);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFCreateSample(out IntPtr ppIMFSample);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFCreateMemoryBuffer(uint cbMaxLength, out IntPtr ppBuffer);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    public static extern int MFTEnumEx(Guid guidCategory, uint flags, IntPtr pInputType,
                                       IntPtr pOutputType, out IntPtr pppMFTActivate, out uint pnumMFTActivate);

    /// <summary>Packs width/height (or numerator/denominator) into the UINT64 MF uses for pair attributes.</summary>
    public static ulong Pack2(uint high, uint low) => ((ulong)high << 32) | low;

    public static void Unpack2(ulong packed, out uint high, out uint low)
    {
        high = (uint)(packed >> 32);
        low = (uint)(packed & 0xFFFFFFFF);
    }

    // ---- Interfaces ---------------------------------------------------------

    /// <summary>
    /// Complete <c>IMFAttributes</c> in IDL order. Media types, samples, events
    /// and activate objects all derive from it, so a QI to this interface works
    /// against any of them.
    /// </summary>
    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFAttributes
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
        [PreserveSig] int GetBlobSize(ref Guid key, out uint size);
        [PreserveSig] int GetBlob(ref Guid key, IntPtr buf, uint bufSize, IntPtr written);
        [PreserveSig] int GetAllocatedBlob(ref Guid key, out IntPtr buf, out uint size);
        [PreserveSig] int GetUnknown(ref Guid key, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem(ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem(ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32(ref Guid key, uint value);
        [PreserveSig] int SetUINT64(ref Guid key, ulong value);
        [PreserveSig] int SetDouble(ref Guid key, double value);
        [PreserveSig] int SetGUID(ref Guid key, ref Guid value);
        [PreserveSig] int SetString(ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob(ref Guid key, IntPtr buf, uint size);
        [PreserveSig] int SetUnknown(ref Guid key, IntPtr unknown);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out uint items);
        [PreserveSig] int GetItemByIndex(uint index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
    }

    /// <summary><c>IMFActivate</c>: IMFAttributes plus three activation methods.</summary>
    [ComImport, Guid("7fee9e9a-4a89-47a6-899c-b6a53a70fb67"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFActivate
    {
        // --- IMFAttributes (slots 3..32) ---
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
        [PreserveSig] int GetBlobSize(ref Guid key, out uint size);
        [PreserveSig] int GetBlob(ref Guid key, IntPtr buf, uint bufSize, IntPtr written);
        [PreserveSig] int GetAllocatedBlob(ref Guid key, out IntPtr buf, out uint size);
        [PreserveSig] int GetUnknown(ref Guid key, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem(ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem(ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32(ref Guid key, uint value);
        [PreserveSig] int SetUINT64(ref Guid key, ulong value);
        [PreserveSig] int SetDouble(ref Guid key, double value);
        [PreserveSig] int SetGUID(ref Guid key, ref Guid value);
        [PreserveSig] int SetString(ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob(ref Guid key, IntPtr buf, uint size);
        [PreserveSig] int SetUnknown(ref Guid key, IntPtr unknown);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out uint items);
        [PreserveSig] int GetItemByIndex(uint index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
        // --- IMFActivate ---
        [PreserveSig] int ActivateObject(ref Guid riid, out IntPtr ppv);
        [PreserveSig] int ShutdownObject();
        [PreserveSig] int DetachObject();
    }

    [ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFTransform
    {
        [PreserveSig] int GetStreamLimits(out uint inMin, out uint inMax, out uint outMin, out uint outMax);
        [PreserveSig] int GetStreamCount(out uint inputs, out uint outputs);
        [PreserveSig] int GetStreamIDs(uint inSize, [Out] uint[] inIDs, uint outSize, [Out] uint[] outIDs);
        [PreserveSig] int GetInputStreamInfo(uint id, out MFT_INPUT_STREAM_INFO info);
        [PreserveSig] int GetOutputStreamInfo(uint id, out MFT_OUTPUT_STREAM_INFO info);
        [PreserveSig] int GetAttributes(out IMFAttributes attrs);
        [PreserveSig] int GetInputStreamAttributes(uint id, out IMFAttributes attrs);
        [PreserveSig] int GetOutputStreamAttributes(uint id, out IMFAttributes attrs);
        [PreserveSig] int DeleteInputStream(uint id);
        [PreserveSig] int AddInputStreams(uint count, [In] uint[] ids);
        [PreserveSig] int GetInputAvailableType(uint id, uint index, out IntPtr type);
        [PreserveSig] int GetOutputAvailableType(uint id, uint index, out IntPtr type);
        [PreserveSig] int SetInputType(uint id, IntPtr type, uint flags);
        [PreserveSig] int SetOutputType(uint id, IntPtr type, uint flags);
        [PreserveSig] int GetInputCurrentType(uint id, out IntPtr type);
        [PreserveSig] int GetOutputCurrentType(uint id, out IntPtr type);
        [PreserveSig] int GetInputStatus(uint id, out uint flags);
        [PreserveSig] int GetOutputStatus(out uint flags);
        [PreserveSig] int SetOutputBounds(long lower, long upper);
        [PreserveSig] int ProcessEvent(uint id, IntPtr evt);
        [PreserveSig] int ProcessMessage(uint message, IntPtr param);
        [PreserveSig] int ProcessInput(uint id, IntPtr sample, uint flags);
        [PreserveSig] int ProcessOutput(uint flags, uint bufferCount, ref MFT_OUTPUT_DATA_BUFFER buffers, out uint status);
    }

    [ComImport, Guid("045FA593-8799-42b8-BC8D-8968C6453507"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFMediaBuffer
    {
        [PreserveSig] int Lock(out IntPtr buffer, out uint maxLength, out uint currentLength);
        [PreserveSig] int Unlock();
        [PreserveSig] int GetCurrentLength(out uint length);
        [PreserveSig] int SetCurrentLength(uint length);
        [PreserveSig] int GetMaxLength(out uint length);
    }

    /// <summary><c>IMFSample</c>: IMFAttributes plus the sample accessors.</summary>
    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFSample
    {
        // --- IMFAttributes ---
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
        [PreserveSig] int GetBlobSize(ref Guid key, out uint size);
        [PreserveSig] int GetBlob(ref Guid key, IntPtr buf, uint bufSize, IntPtr written);
        [PreserveSig] int GetAllocatedBlob(ref Guid key, out IntPtr buf, out uint size);
        [PreserveSig] int GetUnknown(ref Guid key, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem(ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem(ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32(ref Guid key, uint value);
        [PreserveSig] int SetUINT64(ref Guid key, ulong value);
        [PreserveSig] int SetDouble(ref Guid key, double value);
        [PreserveSig] int SetGUID(ref Guid key, ref Guid value);
        [PreserveSig] int SetString(ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob(ref Guid key, IntPtr buf, uint size);
        [PreserveSig] int SetUnknown(ref Guid key, IntPtr unknown);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out uint items);
        [PreserveSig] int GetItemByIndex(uint index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
        // --- IMFSample ---
        [PreserveSig] int GetSampleFlags(out uint flags);
        [PreserveSig] int SetSampleFlags(uint flags);
        [PreserveSig] int GetSampleTime(out long time);
        [PreserveSig] int SetSampleTime(long time);
        [PreserveSig] int GetSampleDuration(out long duration);
        [PreserveSig] int SetSampleDuration(long duration);
        [PreserveSig] int GetBufferCount(out uint count);
        [PreserveSig] int GetBufferByIndex(uint index, out IMFMediaBuffer buffer);
        [PreserveSig] int ConvertToContiguousBuffer(out IMFMediaBuffer buffer);
        [PreserveSig] int AddBuffer(IMFMediaBuffer buffer);
        [PreserveSig] int RemoveBufferByIndex(uint index);
        [PreserveSig] int RemoveAllBuffers();
        [PreserveSig] int GetTotalLength(out uint length);
        [PreserveSig] int CopyToBuffer(IMFMediaBuffer buffer);
    }

    /// <summary><c>IMFMediaEvent</c>: IMFAttributes plus the event accessors.</summary>
    [ComImport, Guid("DF598932-F10C-4E39-BBA2-C308F101DAA3"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFMediaEvent
    {
        // --- IMFAttributes ---
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
        [PreserveSig] int GetBlobSize(ref Guid key, out uint size);
        [PreserveSig] int GetBlob(ref Guid key, IntPtr buf, uint bufSize, IntPtr written);
        [PreserveSig] int GetAllocatedBlob(ref Guid key, out IntPtr buf, out uint size);
        [PreserveSig] int GetUnknown(ref Guid key, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int SetItem(ref Guid key, IntPtr value);
        [PreserveSig] int DeleteItem(ref Guid key);
        [PreserveSig] int DeleteAllItems();
        [PreserveSig] int SetUINT32(ref Guid key, uint value);
        [PreserveSig] int SetUINT64(ref Guid key, ulong value);
        [PreserveSig] int SetDouble(ref Guid key, double value);
        [PreserveSig] int SetGUID(ref Guid key, ref Guid value);
        [PreserveSig] int SetString(ref Guid key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int SetBlob(ref Guid key, IntPtr buf, uint size);
        [PreserveSig] int SetUnknown(ref Guid key, IntPtr unknown);
        [PreserveSig] int LockStore();
        [PreserveSig] int UnlockStore();
        [PreserveSig] int GetCount(out uint items);
        [PreserveSig] int GetItemByIndex(uint index, out Guid key, IntPtr value);
        [PreserveSig] int CopyAllItems(IntPtr dest);
        // --- IMFMediaEvent ---
        [PreserveSig] int GetType(out uint met);
        [PreserveSig] int GetExtendedType(out Guid guid);
        [PreserveSig] int GetStatus(out int status);
        [PreserveSig] int GetValue(IntPtr pv);
    }

    [ComImport, Guid("2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFMediaEventGenerator
    {
        [PreserveSig] int GetEvent(uint flags, out IMFMediaEvent evt);
        [PreserveSig] int BeginGetEvent(IntPtr callback, IntPtr state);
        [PreserveSig] int EndGetEvent(IntPtr result, out IMFMediaEvent evt);
        [PreserveSig] int QueueEvent(uint met, ref Guid extendedType, int status, IntPtr value);
    }

    [ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICodecAPI
    {
        [PreserveSig] int IsSupported(ref Guid api);
        [PreserveSig] int IsModifiable(ref Guid api);
        [PreserveSig] int GetParameterRange(ref Guid api, IntPtr min, IntPtr max, IntPtr step);
        [PreserveSig] int GetParameterValues(ref Guid api, IntPtr values, out uint count);
        [PreserveSig] int GetDefaultValue(ref Guid api, IntPtr value);
        [PreserveSig] int GetValue(ref Guid api, IntPtr value);
        [PreserveSig] int SetValue(ref Guid api, ref PropVariant value);
        // Remaining members (RegisterForEvent, UnregisterForEvent, SetAllDefaults,
        // SetValueWithNotify, SetAllSettings, SetAllSettingsWithNotify) are never
        // dispatched from here; nothing calls past this slot.
    }

    /// <summary>Best-effort codec-API set. A driver that rejects the key is not an error.</summary>
    public static bool TrySetCodecApi(object? transform, Guid key, PropVariant value)
    {
        if (transform is not ICodecAPI api) return false;
        try
        {
            var k = key;
            return api.SetValue(ref k, ref value) >= 0;
        }
        catch { return false; }
    }
}
