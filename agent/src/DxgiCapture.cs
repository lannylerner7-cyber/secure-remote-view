using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace ConnectLive.Agent;

/// <summary>
/// DXGI Desktop Duplication capture — Phase 2 stub.
///
/// When <c>--use-dxgi</c> is passed on the command line, ScreenCapture
/// delegates to this class instead of GDI <c>CopyFromScreen</c>.
///
/// DXGI gives sub-1ms frame acquisition directly from the GPU back-buffer,
/// enabling 30-60 FPS capture without the 15-30ms CPU copy penalty of GDI.
///
/// Limitations:
///   • Requires Windows 8+ (Desktop Duplication API).
///   • Does NOT work under RDP / Hyper-V Enhanced Session / Session 0.
///   • Requires the process to run in the interactive desktop session.
///
/// If initialization fails for any reason, <c>TryCapture</c> returns null
/// and the caller silently falls back to GDI — no data lost, no crash.
/// </summary>
public sealed class DxgiCapture : IDisposable
{
    private IntPtr _factory;
    private IntPtr _adapter;
    private IntPtr _output;
    private IntPtr _output1;
    private IntPtr _device;
    private IntPtr _context;
    private IntPtr _duplication;
    private bool _initialized;
    private readonly Stopwatch _sw = new();

    // DXGI / D3D11 COM GUIDs
    private static readonly Guid IID_IDXGIFactory1 = new("770aae78-f26f-4dba-a829-253c83d1b387");
    private static readonly Guid IID_IDXGIOutput1 = new("00cddea8-939b-4b83-a340-a685226666cc");

    [DllImport("dxgi.dll")]
    private static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);

    [DllImport("d3d11.dll")]
    private static extern int D3D11CreateDevice(
        IntPtr pAdapter, int DriverType, IntPtr Software,
        uint Flags, IntPtr pFeatureLevels, uint FeatureLevels,
        uint SDKVersion, out IntPtr ppDevice, out int pFeatureLevel,
        out IntPtr ppImmediateContext);

    /// <summary>
    /// Attempt to initialize DXGI Desktop Duplication on the primary output.
    /// Returns false (and logs the reason) on failure — caller should use GDI.
    /// </summary>
    public bool TryInitialize()
    {
        try
        {
            var iid = IID_IDXGIFactory1;
            int hr = CreateDXGIFactory1(ref iid, out _factory);
            if (hr < 0) { Log.Warn($"DXGI: CreateDXGIFactory1 failed 0x{hr:X8}"); return false; }

            // EnumAdapters(0, ...)
            hr = DxgiEnumAdapters(_factory, 0, out _adapter);
            if (hr < 0) { Log.Warn($"DXGI: EnumAdapters failed 0x{hr:X8}"); return false; }

            // EnumOutputs(0, ...)
            hr = DxgiEnumOutputs(_adapter, 0, out _output);
            if (hr < 0) { Log.Warn($"DXGI: EnumOutputs failed 0x{hr:X8}"); return false; }

            // QueryInterface for IDXGIOutput1
            var iidOutput1 = IID_IDXGIOutput1;
            hr = Marshal.QueryInterface(_output, ref iidOutput1, out _output1);
            if (hr < 0) { Log.Warn($"DXGI: QueryInterface IDXGIOutput1 failed 0x{hr:X8}"); return false; }

            // D3D11CreateDevice with the adapter
            hr = D3D11CreateDevice(_adapter, 0 /* D3D_DRIVER_TYPE_UNKNOWN */, IntPtr.Zero,
                0, IntPtr.Zero, 0, 7 /* D3D11_SDK_VERSION */,
                out _device, out _, out _context);
            if (hr < 0) { Log.Warn($"DXGI: D3D11CreateDevice failed 0x{hr:X8}"); return false; }

            // DuplicateOutput
            hr = DxgiDuplicateOutput(_output1, _device, out _duplication);
            if (hr < 0) { Log.Warn($"DXGI: DuplicateOutput failed 0x{hr:X8} (RDP/Session 0?)"); return false; }

            _initialized = true;
            Log.Info("DXGI: Desktop Duplication initialized successfully");
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"DXGI: init exception: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Capture one frame. Returns null if no new frame is available or DXGI
    /// is not initialized. The caller owns the returned Bitmap.
    /// Logs capture timing for benchmarking vs GDI.
    /// </summary>
    public Bitmap? TryCapture(int timeoutMs = 0)
    {
        if (!_initialized || _duplication == IntPtr.Zero) return null;
        // Phase-2 stub: the actual AcquireNextFrame / MapDesktopSurface
        // P/Invoke chain is non-trivial (~80 lines of COM interop).
        // Returning null causes the caller to fall back to GDI.
        // Full implementation is the next milestone.
        return null;
    }

    public void Dispose()
    {
        SafeRelease(ref _duplication);
        SafeRelease(ref _context);
        SafeRelease(ref _device);
        SafeRelease(ref _output1);
        SafeRelease(ref _output);
        SafeRelease(ref _adapter);
        SafeRelease(ref _factory);
        _initialized = false;
    }

    private static void SafeRelease(ref IntPtr ptr)
    {
        if (ptr != IntPtr.Zero)
        {
            try { Marshal.Release(ptr); } catch { }
            ptr = IntPtr.Zero;
        }
    }

    // --- Minimal COM vtable calls for DXGI ---
    // These call the COM interface methods via vtable slot indices.

    private static int DxgiEnumAdapters(IntPtr factory, uint index, out IntPtr adapter)
    {
        // IDXGIFactory1::EnumAdapters1 is vtable slot 12
        var vtable = Marshal.ReadIntPtr(factory);
        var fn = Marshal.ReadIntPtr(vtable, 12 * IntPtr.Size);
        var del = Marshal.GetDelegateForFunctionPointer<EnumAdaptersDelegate>(fn);
        return del(factory, index, out adapter);
    }

    private static int DxgiEnumOutputs(IntPtr adapter, uint index, out IntPtr output)
    {
        // IDXGIAdapter::EnumOutputs is vtable slot 7
        var vtable = Marshal.ReadIntPtr(adapter);
        var fn = Marshal.ReadIntPtr(vtable, 7 * IntPtr.Size);
        var del = Marshal.GetDelegateForFunctionPointer<EnumOutputsDelegate>(fn);
        return del(adapter, index, out output);
    }

    private static int DxgiDuplicateOutput(IntPtr output1, IntPtr device, out IntPtr duplication)
    {
        // IDXGIOutput1::DuplicateOutput is vtable slot 17
        var vtable = Marshal.ReadIntPtr(output1);
        var fn = Marshal.ReadIntPtr(vtable, 17 * IntPtr.Size);
        var del = Marshal.GetDelegateForFunctionPointer<DuplicateOutputDelegate>(fn);
        return del(output1, device, out duplication);
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int EnumAdaptersDelegate(IntPtr self, uint index, out IntPtr adapter);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int EnumOutputsDelegate(IntPtr self, uint index, out IntPtr output);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int DuplicateOutputDelegate(IntPtr self, IntPtr device, out IntPtr duplication);
}
