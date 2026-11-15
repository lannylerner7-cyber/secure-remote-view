using System;
using System.Runtime.InteropServices;

namespace ConnectLive.Agent;

/// <summary>
/// Resolve an actual microphone capture endpoint, not WAVE_MAPPER (which can
/// select Stereo Mix). Unknown/line-level endpoints and unmappable drivers fail
/// closed. Endpoint IDs/form factors come from Windows, never display names.
/// </summary>
internal static class MicrophoneEndpoint
{
    internal sealed record Selection(uint Index, string EndpointId);
    internal static bool IsMicrophoneFormFactor(uint value) => value is 4 or 5 or 6; // microphone/headset/handset

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Enumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr collection);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out Device device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Device
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr instance);
        [PreserveSig] int OpenPropertyStore(uint access, out Properties properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Properties
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropertyValue { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public uint Value; }
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropertyValue value);
    [DllImport("winmm.dll")] private static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll")] private static extern uint waveInMessage(IntPtr deviceOrHandle, uint message, IntPtr first, IntPtr second);
    private const uint QueryId = 0x0811, QueryIdSize = 0x0812; // mmddk.h function-instance ID / ID size

    internal static Selection Select()
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("device_unavailable");
        Enumerator? enumerator = null; Device? device = null; Properties? properties = null;
        try
        {
            enumerator = (Enumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(
                new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"))!)!;
            // eCapture, eCommunications: never an output/loopback endpoint.
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(1, 2, out device));
            Marshal.ThrowExceptionForHR(device.GetState(out uint state));
            if (state != 1) throw new InvalidOperationException("device_unavailable");
            Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0, out properties));
            var key = new PropertyKey { Format = new Guid("1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E"), Id = 0 };
            Marshal.ThrowExceptionForHR(properties.GetValue(ref key, out var form));
            try
            {
                if (form.Type != 19 || !IsMicrophoneFormFactor(form.Value))
                    throw new InvalidOperationException("device_unavailable");
            }
            finally { PropVariantClear(ref form); }
            Marshal.ThrowExceptionForHR(device.GetId(out string expected));
            // Map by Windows function-instance identity, never name matching.
            uint count = Math.Min(waveInGetNumDevs(), 64u);
            for (uint index = 0; index < count; index++)
                if (Matches(new IntPtr(index), expected)) return new Selection(index, expected);
            throw new InvalidOperationException("device_unavailable");
        }
        finally
        {
            if (properties != null) Marshal.ReleaseComObject(properties);
            if (device != null) Marshal.ReleaseComObject(device);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }

    internal static bool Matches(IntPtr deviceOrHandle, string expected)
    {
        // Windows documents the result as size_t, not DWORD: allocate and read
        // pointer width on x64, even if an older driver writes only 32 bits.
        IntPtr size = Marshal.AllocHGlobal(IntPtr.Size), value = IntPtr.Zero;
        try
        {
            Marshal.Copy(new byte[IntPtr.Size], 0, size, IntPtr.Size);
            if (waveInMessage(deviceOrHandle, QueryIdSize, size, IntPtr.Zero) != 0) return false;
            long length = IntPtr.Size == 8 ? Marshal.ReadInt64(size) : Marshal.ReadInt32(size);
            if (length < 2 || length > 4096 || length % 2 != 0) return false;
            int bytes = (int)length;
            value = Marshal.AllocHGlobal(bytes);
            // Drivers must not be able to leave uninitialized memory in an ID.
            Marshal.Copy(new byte[bytes], 0, value, bytes);
            if (waveInMessage(deviceOrHandle, QueryId, value, new IntPtr(bytes)) != 0) return false;
            string actual = Marshal.PtrToStringUni(value, bytes / 2)!.TrimEnd('\0');
            return string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);
        }
        finally { if (value != IntPtr.Zero) Marshal.FreeHGlobal(value); Marshal.FreeHGlobal(size); }
    }
}
