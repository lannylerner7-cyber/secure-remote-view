using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace ConnectLive.Admin.Media;

/// <summary>
/// WPF <c>D3DImage</c> host for the native video path (contract R4).
///
/// Ownership model — this is the part that used to be missing:
///   * the host owns ONE <c>IDirect3DDevice9Ex</c> and ONE reusable render
///     target surface. Nothing is recreated per frame, and nothing is
///     recreated per session — <see cref="Park"/> releases the surface and
///     keeps the device warm so connect → end → reconnect ×3 causes no device
///     churn (contract G3).
///   * the surface is recreated only when the source resolution changes
///     (Phase 4) or after a device-lost/reset (Gate C).
///
/// STA guardrail: decode happens on a worker thread; <c>Lock</c> /
/// <c>SetBackBuffer</c> / <c>AddDirtyRect</c> / <c>Unlock</c> are marshalled to
/// the UI dispatcher. The pixel upload into the D3D surface happens on the
/// caller's thread (the device is created MULTITHREADED for exactly this).
///
/// If anything in the D3D path fails, <see cref="Available"/> goes false and
/// the caller falls back to the <c>WriteableBitmap</c> presenter — the picture
/// never disappears because of a GPU quirk.
/// </summary>
public sealed class D3DImageHost : IDisposable
{
    public D3DImage Image { get; } = new D3DImage();

    private readonly object _gate = new();
    private IntPtr _d3d;
    private IntPtr _device;
    private IntPtr _surface;
    private int _surfW, _surfH;
    private bool _disposed;
    private bool _failed;

    /// <summary>False once the D3D path has given up; caller should use the bitmap presenter.</summary>
    public bool Available => !_failed && !_disposed;

    /// <summary>Number of device (re)creations — surfaced by the stats logger for G3.</summary>
    public int DeviceCreations { get; private set; }

    /// <summary>Number of surface (re)allocations — must stay flat during a steady session.</summary>
    public int SurfaceAllocations { get; private set; }

    private bool EnsureDevice()
    {
        if (_device != IntPtr.Zero) return true;
        try
        {
            if (_d3d == IntPtr.Zero)
            {
                var hr0 = D3D9Ex.Direct3DCreate9Ex(D3D9Ex.D3D_SDK_VERSION, out _d3d);
                if (hr0 != D3D9Ex.D3D_OK || _d3d == IntPtr.Zero) { Fail("Direct3DCreate9Ex 0x" + hr0.ToString("X8")); return false; }
            }

            var hwnd = GetFocusWindow();
            var pp = new D3D9Ex.D3DPRESENT_PARAMETERS
            {
                BackBufferWidth = 1,
                BackBufferHeight = 1,
                BackBufferFormat = D3D9Ex.D3DFMT_A8R8G8B8,
                BackBufferCount = 1,
                SwapEffect = D3D9Ex.D3DSWAPEFFECT_DISCARD,
                hDeviceWindow = hwnd,
                Windowed = 1,
                PresentationInterval = 0,
            };
            var hr = D3D9Ex.CreateDeviceEx(_d3d, hwnd, ref pp, out _device);
            if (hr != D3D9Ex.D3D_OK || _device == IntPtr.Zero) { Fail("CreateDeviceEx 0x" + hr.ToString("X8")); return false; }
            DeviceCreations++;
            System.Diagnostics.Debug.WriteLine($"[d3d] device created (#{DeviceCreations})");
            return true;
        }
        catch (DllNotFoundException) { Fail("d3d9.dll unavailable"); return false; }
        catch (Exception ex) { Fail(ex.Message); return false; }
    }

    private static IntPtr GetFocusWindow()
    {
        try
        {
            var w = Application.Current?.MainWindow;
            if (w != null)
            {
                var h = new WindowInteropHelper(w).EnsureHandle();
                if (h != IntPtr.Zero) return h;
            }
        }
        catch { }
        return IntPtr.Zero; // desktop window is acceptable for an offscreen device
    }

    private bool EnsureSurface(int width, int height)
    {
        if (_surface != IntPtr.Zero && _surfW == width && _surfH == height) return true;
        ReleaseSurface();
        var hr = D3D9Ex.CreateRenderTarget(_device, width, height, out _surface);
        if (hr != D3D9Ex.D3D_OK || _surface == IntPtr.Zero)
        {
            if (D3D9Ex.IsDeviceLost(hr)) { RecreateDevice(); return false; }
            Fail("CreateRenderTarget 0x" + hr.ToString("X8"));
            return false;
        }
        _surfW = width; _surfH = height;
        SurfaceAllocations++;
        System.Diagnostics.Debug.WriteLine($"[d3d] surface {width}x{height} (#{SurfaceAllocations})");
        return true;
    }

    /// <summary>
    /// Upload one tightly-packed BGRA32 frame and present it.
    /// Returns false when the caller should fall back to the bitmap presenter
    /// for this frame (device lost mid-upload, or the D3D path has failed).
    /// </summary>
    public bool PushBgra(byte[] bgra, int width, int height)
    {
        if (_disposed || _failed) return false;
        if (bgra == null || width <= 0 || height <= 0) return false;
        long need = (long)width * height * 4;
        if (bgra.LongLength < need) return false;

        lock (_gate)
        {
            if (!EnsureDevice()) return false;

            var state = D3D9Ex.TestCooperativeLevel(_device);
            if (D3D9Ex.IsDeviceLost(state)) { RecreateDevice(); return false; }

            if (!EnsureSurface(width, height)) return false;

            var hr = D3D9Ex.LockRect(_surface, out var locked);
            if (hr != D3D9Ex.D3D_OK || locked.pBits == IntPtr.Zero)
            {
                if (D3D9Ex.IsDeviceLost(hr)) RecreateDevice();
                return false;
            }
            try
            {
                int rowBytes = width * 4;
                if (locked.Pitch == rowBytes)
                {
                    System.Runtime.InteropServices.Marshal.Copy(bgra, 0, locked.pBits, rowBytes * height);
                }
                else
                {
                    // Respecting the surface pitch is what keeps diagonal
                    // stripes off the screen — never assume packed rows.
                    for (int y = 0; y < height; y++)
                    {
                        var dst = IntPtr.Add(locked.pBits, y * locked.Pitch);
                        System.Runtime.InteropServices.Marshal.Copy(bgra, y * rowBytes, dst, rowBytes);
                    }
                }
            }
            catch { return false; }
            finally { try { D3D9Ex.UnlockRect(_surface); } catch { } }
        }

        Present(width, height);
        return true;
    }

    private void Present(int width, int height)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher == null) return;
        if (dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished) return;

        if (dispatcher.CheckAccess()) { ApplyOnUi(width, height); return; }
        try
        {
            // BeginInvoke, not InvokeAsync-with-await: dropping a late frame is
            // strictly better than back-pressuring the decoder thread.
            dispatcher.BeginInvoke(new Action(() => ApplyOnUi(width, height)), DispatcherPriority.Render);
        }
        catch (TaskCanceledException) { }
        catch (InvalidOperationException) { }
    }

    private void ApplyOnUi(int width, int height)
    {
        IntPtr surface;
        lock (_gate) { surface = _surface; }
        if (surface == IntPtr.Zero) return;
        try
        {
            Image.Lock();
            Image.SetBackBuffer(D3DResourceType.IDirect3DSurface9, surface);
            if (Image.IsFrontBufferAvailable)
                Image.AddDirtyRect(new Int32Rect(0, 0, width, height));
        }
        catch (Exception)
        {
            // Surface may have been released between marshal and apply.
        }
        finally
        {
            try { Image.Unlock(); } catch { }
        }
    }

    private void RecreateDevice()
    {
        System.Diagnostics.Debug.WriteLine("[d3d] device lost — recreating");
        ReleaseSurface();
        D3D9Ex.Release(ref _device);
        // The next PushBgra rebuilds device + surface; frames in flight are
        // dropped rather than queued, which is what "continue, don't stall"
        // means for a live view.
    }

    private void ReleaseSurface()
    {
        // Detach from D3DImage first so WPF never holds a dead pointer.
        var dispatcher = Application.Current?.Dispatcher;
        try
        {
            if (dispatcher != null && !dispatcher.HasShutdownStarted)
            {
                dispatcher.Invoke(() =>
                {
                    try { Image.Lock(); Image.SetBackBuffer(D3DResourceType.IDirect3DSurface9, IntPtr.Zero); }
                    catch { }
                    finally { try { Image.Unlock(); } catch { } }
                });
            }
        }
        catch { }
        D3D9Ex.Release(ref _surface);
        _surfW = _surfH = 0;
    }

    /// <summary>
    /// Session ended: release the surface, keep the device.
    /// G3 requires no per-session device churn.
    /// </summary>
    public void Park()
    {
        lock (_gate) { ReleaseSurface(); }
    }

    private void Fail(string why)
    {
        _failed = true;
        System.Diagnostics.Debug.WriteLine("[d3d] unavailable — " + why + " (falling back to WriteableBitmap)");
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            ReleaseSurface();
            D3D9Ex.Release(ref _device);
            D3D9Ex.Release(ref _d3d);
        }
    }
}
