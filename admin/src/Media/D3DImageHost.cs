using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace ConnectLive.Admin.Media;

/// <summary>
/// WPF <c>D3DImage</c> host for the native video path (contract R4).
///
/// Ownership model:
///   * the host owns ONE <c>IDirect3DDevice9Ex</c> and ONE reusable render
///     target surface. Nothing is recreated per frame, and nothing is
///     recreated per session — <see cref="Park"/> releases the surface and
///     keeps the device warm so connect → end → reconnect ×3 causes no device
///     churn (contract G3).
///   * the surface is recreated only when the source resolution changes
///     (Phase 4) or after a device-lost/reset (Gate C).
///
/// S12 — device-lost survival. Four real-world events kill a D3D9Ex device
/// under a technician's feet and each needs a different amount of rebuilding:
///   1. TDR / GPU hang            → D3DERR_DEVICEHUNG      → recreate device
///   2. Driver update / reinstall → D3DERR_DEVICEREMOVED   → recreate device AND
///                                                            the IDirect3D9Ex
///                                                            factory (the old
///                                                            one is bound to
///                                                            the dead driver)
///   3. RDP attach/detach, lock   → front buffer disappears; WPF raises
///      screen, dGPU/iGPU flip      <c>IsFrontBufferAvailableChanged</c> with no
///                                  HRESULT anywhere — polling alone never
///                                  notices, so we subscribe.
///   4. Anything that keeps       → thrash guard: more than
///      failing                     <see cref="MaxLossesPerWindow"/> losses inside
///                                  <see cref="LossWindowMs"/> retires the D3D path
///                                  for the session and the caller falls back to
///                                  the WriteableBitmap presenter. A degraded
///                                  picture beats a strobing one.
///
/// STA guardrail: decode happens on a worker thread; <c>Lock</c> /
/// <c>SetBackBuffer</c> / <c>AddDirtyRect</c> / <c>Unlock</c> are marshalled to
/// the UI dispatcher. The pixel upload into the D3D surface happens on the
/// caller's thread (the device is created MULTITHREADED for exactly this).
/// </summary>
public sealed class D3DImageHost : IDisposable
{
    /// <summary>More losses than this inside <see cref="LossWindowMs"/> retires the D3D path.</summary>
    public const int MaxLossesPerWindow = 5;
    public const int LossWindowMs = 10_000;

    public D3DImage Image { get; } = new D3DImage();

    private readonly object _gate = new();
    private readonly Queue<long> _lossTimes = new();
    private IntPtr _d3d;
    private IntPtr _device;
    private IntPtr _surface;
    private int _surfW, _surfH;
    private bool _disposed;
    private bool _failed;

    /// <summary>Set when the last loss requires a brand new IDirect3D9Ex, not just a device.</summary>
    private bool _rebuildFactory;

    public D3DImageHost()
    {
        // Case 3: the only signal for an RDP/session/adapter switch. WPF drops
        // the front buffer and never tells the HRESULT path about it, so the
        // surface must be re-attached (or rebuilt) when it comes back.
        Image.IsFrontBufferAvailableChanged += OnFrontBufferAvailableChanged;
    }

    /// <summary>False once the D3D path has given up; caller should use the bitmap presenter.</summary>
    public bool Available => !_failed && !_disposed;

    /// <summary>Number of device (re)creations — surfaced by the stats logger for G3.</summary>
    public int DeviceCreations { get; private set; }

    /// <summary>Number of surface (re)allocations — must stay flat during a steady session.</summary>
    public int SurfaceAllocations { get; private set; }

    /// <summary>S12 — how many device-lost events were observed this session.</summary>
    public int DeviceLosses { get; private set; }

    /// <summary>S12 — how many of those were recovered (a later frame presented through D3D).</summary>
    public int DeviceRecoveries { get; private set; }

    /// <summary>S12 — last loss cause, human readable ("hung", "removed", "front-buffer", ...).</summary>
    public string LastLossReason { get; private set; } = "";

    /// <summary>Raised (caller thread) on every loss with the reason.</summary>
    public event Action<string>? DeviceLost;

    /// <summary>Raised (caller thread) the first time a frame presents after a loss.</summary>
    public event Action? DeviceRecovered;

    private bool _lossPending;

    private bool EnsureDevice()
    {
        if (_device != IntPtr.Zero) return true;
        try
        {
            if (_rebuildFactory)
            {
                D3D9Ex.Release(ref _d3d);
                _rebuildFactory = false;
            }

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
            if (hr != D3D9Ex.D3D_OK || _device == IntPtr.Zero)
            {
                // A driver that is mid-reinstall answers DEVICELOST/NOTRESET to
                // CreateDeviceEx too. That is a retry, not a permanent failure —
                // the thrash guard is what ends the retries.
                if (D3D9Ex.IsDeviceLost(hr)) { NoteLoss("create:0x" + hr.ToString("X8"), removed: hr == D3D9Ex.D3DERR_DEVICEREMOVED); return false; }
                Fail("CreateDeviceEx 0x" + hr.ToString("X8"));
                return false;
            }
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
            if (D3D9Ex.IsDeviceLost(hr)) { RecreateDevice("surface:0x" + hr.ToString("X8"), hr == D3D9Ex.D3DERR_DEVICEREMOVED); return false; }
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
            if (D3D9Ex.IsDeviceLost(state))
            {
                RecreateDevice("cooplevel:0x" + state.ToString("X8"), state == D3D9Ex.D3DERR_DEVICEREMOVED);
                return false;
            }

            if (!EnsureSurface(width, height)) return false;

            var hr = D3D9Ex.LockRect(_surface, out var locked);
            if (hr != D3D9Ex.D3D_OK || locked.pBits == IntPtr.Zero)
            {
                if (D3D9Ex.IsDeviceLost(hr)) RecreateDevice("lock:0x" + hr.ToString("X8"), hr == D3D9Ex.D3DERR_DEVICEREMOVED);
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

        if (_lossPending)
        {
            _lossPending = false;
            DeviceRecoveries++;
            System.Diagnostics.Debug.WriteLine($"[d3d] recovered after loss (#{DeviceRecoveries})");
            try { DeviceRecovered?.Invoke(); } catch { }
        }
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

    /// <summary>
    /// Case 3 — RDP attach/detach, screen lock, adapter switch. No HRESULT is
    /// ever produced; WPF simply drops the front buffer. When it returns we
    /// rebuild the device and surface from scratch: the old surface belongs to
    /// a display object that may no longer exist.
    /// </summary>
    private void OnFrontBufferAvailableChanged(object? sender, DependencyPropertyChangedEventArgs e)
    {
        bool available = e.NewValue is bool b && b;
        if (_disposed) return;
        if (!available)
        {
            System.Diagnostics.Debug.WriteLine("[d3d] front buffer lost (rdp/lock/adapter switch)");
            return;
        }
        lock (_gate) { RecreateDevice("front-buffer", removed: false); }
    }

    private void RecreateDevice(string reason, bool removed)
    {
        NoteLoss(reason, removed);
        ReleaseSurface();
        D3D9Ex.Release(ref _device);
        // The next PushBgra rebuilds device + surface; frames in flight are
        // dropped rather than queued, which is what "continue, don't stall"
        // means for a live view.
    }

    /// <summary>Records the loss, arms the recovery edge, and applies the thrash guard.</summary>
    private void NoteLoss(string reason, bool removed)
    {
        DeviceLosses++;
        LastLossReason = reason;
        _lossPending = true;
        if (removed) _rebuildFactory = true;   // driver gone: the factory is stale too
        System.Diagnostics.Debug.WriteLine($"[d3d] device lost ({reason}) — recreating (#{DeviceLosses})");
        try { DeviceLost?.Invoke(reason); } catch { }

        var now = Environment.TickCount64;
        _lossTimes.Enqueue(now);
        while (_lossTimes.Count > 0 && now - _lossTimes.Peek() > LossWindowMs) _lossTimes.Dequeue();
        if (_lossTimes.Count > MaxLossesPerWindow)
            Fail($"{_lossTimes.Count} device losses in {LossWindowMs / 1000}s (last: {reason})");
    }

    private void ReleaseSurface()
    {
        // Detach from D3DImage first so WPF never holds a dead pointer.
        var dispatcher = Application.Current?.Dispatcher;
        try
        {
            if (dispatcher != null && !dispatcher.HasShutdownStarted)
            {
                Action detach = () =>
                {
                    try { Image.Lock(); Image.SetBackBuffer(D3DResourceType.IDirect3DSurface9, IntPtr.Zero); }
                    catch { }
                    finally { try { Image.Unlock(); } catch { } }
                };
                // Invoke would deadlock when the UI thread itself is inside
                // OnFrontBufferAvailableChanged holding _gate.
                if (dispatcher.CheckAccess()) detach();
                else dispatcher.Invoke(detach);
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

    /// <summary>
    /// Gate C / S12 evidence hook: drop the device exactly the way a real
    /// device-lost drops it, so the spike can prove recovery. Harmless in
    /// production (the next PushBgra rebuilds), but only the spike calls it.
    /// </summary>
    /// <param name="removed">
    /// true simulates D3DERR_DEVICEREMOVED (driver update: factory rebuilt too),
    /// false simulates a plain TDR/hang.
    /// </param>
    public void SimulateDeviceLossForTest(bool removed = false)
    {
        lock (_gate) { RecreateDevice(removed ? "test:removed" : "test:hung", removed); }
    }

    /// <summary>S12 evidence hook: simulate the RDP/lock front-buffer round trip.</summary>
    public void SimulateFrontBufferLossForTest()
    {
        OnFrontBufferAvailableChanged(this, new DependencyPropertyChangedEventArgs(
            D3DImage.IsFrontBufferAvailableProperty, false, true));
    }

    /// <summary>One-line S12 evidence for the per-minute stats logger.</summary>
    public string HealthLine() =>
        $"devices={DeviceCreations} surfaces={SurfaceAllocations} losses={DeviceLosses} " +
        $"recovered={DeviceRecoveries} available={Available}" +
        (LastLossReason.Length > 0 ? $" lastloss={LastLossReason}" : "");

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
            try { Image.IsFrontBufferAvailableChanged -= OnFrontBufferAvailableChanged; } catch { }
            ReleaseSurface();
            D3D9Ex.Release(ref _device);
            D3D9Ex.Release(ref _d3d);
        }
    }
}
