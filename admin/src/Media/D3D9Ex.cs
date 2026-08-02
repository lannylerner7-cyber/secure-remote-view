using System;
using System.Runtime.InteropServices;

namespace ConnectLive.Admin.Media;

/// <summary>
/// Gate C — minimal Direct3D 9Ex interop for the WPF <c>D3DImage</c> present
/// path (contract ruling R4: D3D9Ex + D3DImage, no hedge).
///
/// Deliberately vtable-index based instead of full <c>ComImport</c> interfaces:
/// <c>IDirect3DDevice9</c> has ~119 entries and only four of them matter here,
/// so transcribing the whole vtable would add ~115 chances to get an ordering
/// wrong for zero benefit.
///
/// Indices used (stable since the DX9 SDK, never reordered):
///   IDirect3D9Ex      : CreateDeviceEx          = 20
///   IDirect3DDevice9  : TestCooperativeLevel    =  3
///                       CreateRenderTarget      = 28
///   IDirect3DSurface9 : LockRect                = 13
///                       UnlockRect              = 14
///   IUnknown          : Release                 =  2
/// </summary>
internal static class D3D9Ex
{
    public const int D3D_OK = 0;
    public const int D3DERR_DEVICELOST = unchecked((int)0x88760868);
    public const int D3DERR_DEVICEHUNG = unchecked((int)0x88760874);
    public const int D3DERR_DEVICEREMOVED = unchecked((int)0x88760870);
    public const int D3DERR_DEVICENOTRESET = unchecked((int)0x88760869);

    public const uint D3DFMT_A8R8G8B8 = 21;
    public const uint D3DDEVTYPE_HAL = 1;
    public const uint D3DSWAPEFFECT_DISCARD = 1;
    public const uint D3DPOOL_DEFAULT = 0;

    // Software vertex processing + multithreaded + FPU preserve: we never draw
    // geometry, we only own a surface, so the cheapest safe combination wins.
    public const uint D3DCREATE_SOFTWARE_VERTEXPROCESSING = 0x00000020;
    public const uint D3DCREATE_MULTITHREADED = 0x00000004;
    public const uint D3DCREATE_FPU_PRESERVE = 0x00000002;

    [DllImport("d3d9.dll", ExactSpelling = true)]
    public static extern int Direct3DCreate9Ex(uint sdkVersion, out IntPtr d3d9Ex);

    public const uint D3D_SDK_VERSION = 32;

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DPRESENT_PARAMETERS
    {
        public uint BackBufferWidth;
        public uint BackBufferHeight;
        public uint BackBufferFormat;
        public uint BackBufferCount;
        public uint MultiSampleType;
        public uint MultiSampleQuality;
        public uint SwapEffect;
        public IntPtr hDeviceWindow;
        public int Windowed;
        public int EnableAutoDepthStencil;
        public uint AutoDepthStencilFormat;
        public uint Flags;
        public uint FullScreen_RefreshRateInHz;
        public uint PresentationInterval;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct D3DLOCKED_RECT
    {
        public int Pitch;
        public IntPtr pBits;
    }

    // ---- delegate shapes -------------------------------------------------

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CreateDeviceExDel(IntPtr self, uint adapter, uint deviceType, IntPtr hFocusWindow,
        uint behaviorFlags, ref D3DPRESENT_PARAMETERS pp, IntPtr fullscreenMode, out IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int TestCooperativeLevelDel(IntPtr self);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CreateRenderTargetDel(IntPtr self, uint width, uint height, uint format,
        uint multiSample, uint multisampleQuality, int lockable, out IntPtr surface, IntPtr sharedHandle);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int LockRectDel(IntPtr self, out D3DLOCKED_RECT locked, IntPtr rect, uint flags);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int UnlockRectDel(IntPtr self);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate uint ReleaseDel(IntPtr self);

    private static T Vtbl<T>(IntPtr obj, int index) where T : Delegate
    {
        var vtbl = Marshal.ReadIntPtr(obj);
        var fn = Marshal.ReadIntPtr(vtbl, index * IntPtr.Size);
        return Marshal.GetDelegateForFunctionPointer<T>(fn);
    }

    // ---- wrappers --------------------------------------------------------

    public static int CreateDeviceEx(IntPtr d3d9Ex, IntPtr hwnd, ref D3DPRESENT_PARAMETERS pp, out IntPtr device)
        => Vtbl<CreateDeviceExDel>(d3d9Ex, 20)(d3d9Ex, 0, D3DDEVTYPE_HAL, hwnd,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING | D3DCREATE_MULTITHREADED | D3DCREATE_FPU_PRESERVE,
            ref pp, IntPtr.Zero, out device);

    public static int TestCooperativeLevel(IntPtr device)
        => Vtbl<TestCooperativeLevelDel>(device, 3)(device);

    public static int CreateRenderTarget(IntPtr device, int width, int height, out IntPtr surface)
        => Vtbl<CreateRenderTargetDel>(device, 28)(device, (uint)width, (uint)height,
            D3DFMT_A8R8G8B8, 0, 0, 1 /* lockable — D3DImage requires it */, out surface, IntPtr.Zero);

    public static int LockRect(IntPtr surface, out D3DLOCKED_RECT locked)
        => Vtbl<LockRectDel>(surface, 13)(surface, out locked, IntPtr.Zero, 0);

    public static int UnlockRect(IntPtr surface)
        => Vtbl<UnlockRectDel>(surface, 14)(surface);

    public static void Release(ref IntPtr obj)
    {
        if (obj == IntPtr.Zero) return;
        try { Vtbl<ReleaseDel>(obj, 2)(obj); } catch { }
        obj = IntPtr.Zero;
    }

    public static bool IsDeviceLost(int hr)
        => hr == D3DERR_DEVICELOST || hr == D3DERR_DEVICEHUNG ||
           hr == D3DERR_DEVICEREMOVED || hr == D3DERR_DEVICENOTRESET;
}
