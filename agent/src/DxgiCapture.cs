using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using SharpGen.Runtime;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace ConnectLive.Agent;

/// <summary>
/// DXGI Desktop Duplication capture — enterprise pipeline replacement for
/// the old GDI <c>Graphics.CopyFromScreen</c> path. Grabs frames straight
/// from the GPU back-buffer via <c>IDXGIOutputDuplication</c>, honouring
/// DXGI's dirty-rect metadata so idle frames cost effectively zero CPU.
///
/// Wiring model:
///   • <see cref="TryInitialize"/> — safe probe. Returns false on RDP,
///     Session 0, missing D3D11, or any COM failure so the caller falls
///     back to GDI without losing a frame.
///   • <see cref="TryCapture"/> — hot path. Returns a BGRA <see cref="Bitmap"/>
///     when a *new* frame is available (or when <paramref name="forceRefresh"/>
///     is true, e.g. periodic keyframes). Null means "no change since last
///     call" — the caller should keep serving the last cached frame.
///   • <see cref="LastFrameHadContentChange"/> — reflects the most recent
///     AcquireNextFrame result. When false, ScreenCapture can skip encode
///     entirely and stall its idle backoff.
///
/// SCOPE:CAPTURE multi-monitor contract (was: hardcoded <c>EnumOutputs(0)</c>):
/// the output to duplicate is chosen by <see cref="MonitorSelector"/> and
/// matched on <c>DXGI_OUTPUT_DESC.DeviceName</c> — DXGI's output ordering is
/// NOT the same as <c>Screen.AllScreens</c> ordering, and on multi-GPU rigs
/// the target output may not even hang off the default adapter. We therefore
/// walk every adapter × output, and create the D3D11 device on the adapter
/// that actually owns the display. <see cref="OffsetX"/>/<see cref="OffsetY"/>
/// expose that monitor's desktop origin so cursor and input math can be
/// expressed in the same space as the pixels we ship.
///
/// Dependencies: Vortice.Direct3D11 + Vortice.DXGI (pure-managed, single-file
/// publish safe, MIT). Chosen over SharpDX because SharpDX is unmaintained
/// and its native COM interop breaks under net8 single-file trimming.
/// </summary>
public sealed class DxgiCapture : IDisposable
{
    private static readonly FeatureLevel[] FeatureLevels =
    {
        FeatureLevel.Level_11_0, FeatureLevel.Level_10_1, FeatureLevel.Level_10_0,
    };

    private IDXGIOutputDuplication? _duplication;
    private ID3D11Device? _device;
    private ID3D11DeviceContext? _context;
    private ID3D11Texture2D? _staging;
    private int _width;
    private int _height;
    private bool _initialized;
    private bool _lastFrameChanged;
    // True once the staging texture holds a real desktop image (a frame whose
    // LastPresentTime was non-zero). Until then the staging texture is
    // zero-filled, and copying or mapping it ships a black picture.
    private bool _haveImage;
    private string _deviceName = "";
    private int _offsetX;
    private int _offsetY;
    private readonly Stopwatch _sw = new();

    public bool IsInitialized => _initialized;
    public bool LastFrameHadContentChange => _lastFrameChanged;
    /// <summary>True once at least one real desktop image has been captured on this duplication.</summary>
    public bool HasImage => _haveImage;
    public int Width => _width;
    public int Height => _height;

    /// <summary>Windows device name of the duplicated output (e.g. <c>\\.\DISPLAY2</c>).</summary>
    public string DeviceName => _deviceName;

    /// <summary>Desktop-coordinate X origin of the duplicated output.</summary>
    public int OffsetX => _offsetX;

    /// <summary>Desktop-coordinate Y origin of the duplicated output.</summary>
    public int OffsetY => _offsetY;

    /// <summary>
    /// True when the duplicated output no longer matches what
    /// <see cref="MonitorSelector"/> wants — the capture loop should rebuild.
    /// </summary>
    public bool IsStale =>
        _initialized &&
        !string.Equals(_deviceName, MonitorSelector.SelectedDeviceName, StringComparison.OrdinalIgnoreCase);

    public bool TryInitialize() => TryInitialize(MonitorSelector.Resolve());

    public bool TryInitialize(MonitorSelector.MonitorInfo target)
    {
        try
        {
            if (TryBuildForDisplay(target.DeviceName)) return true;

            // The named display could not be duplicated (RDP, mirrored driver,
            // Session 0, protected content). Rather than losing the session,
            // use GDI on the requested display rather than exposing a different
            // monitor or repeatedly rebuilding a mismatched duplication.
            Log.Warn($"DXGI: '{target.DeviceName}' not duplicable — use GDI for the selected display");
            Dispose();
            return false;
        }
        catch (SharpGenException ex)
        {
            Log.Warn($"DXGI: init failed 0x{ex.HResult:X8} — {ex.Message}");
            Dispose();
            return false;
        }
        catch (Exception ex)
        {
            Log.Warn($"DXGI: init exception: {ex.Message}");
            Dispose();
            return false;
        }
    }

    /// <summary>
    /// Walk every adapter × output looking for the requested display name and
    /// duplicate it on the adapter that owns it.
    /// </summary>
    private bool TryBuildForDisplay(string wantDeviceName)
    {
        if (string.IsNullOrWhiteSpace(wantDeviceName)) return false;

        IDXGIFactory1? factory = null;
        try { factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>(); }
        catch (Exception ex) { Log.Warn($"DXGI: factory create failed: {ex.Message}"); return false; }
        if (factory is null) return false;

        using (factory)
        {
            for (uint a = 0; ; a++)
            {
                IDXGIAdapter1? adapter;
                try
                {
                    if (factory.EnumAdapters1(a, out adapter).Failure || adapter is null) break;
                }
                catch { break; }

                using (adapter)
                {
                    for (uint o = 0; ; o++)
                    {
                        IDXGIOutput? output;
                        try
                        {
                            if (adapter.EnumOutputs(o, out output).Failure || output is null) break;
                        }
                        catch { break; }

                        using (output)
                        {
                            OutputDescription desc;
                            try { desc = output.Description; }
                            catch { continue; }

                            if (!string.Equals(desc.DeviceName, wantDeviceName, StringComparison.OrdinalIgnoreCase))
                                continue;

                            if (BuildFrom(adapter, output, desc)) return true;
                            // Matched the name but duplication failed — no other
                            // output carries this display, so stop searching.
                            Dispose();
                            return false;
                        }
                    }
                }
            }
        }

        Log.Warn($"DXGI: no output reported device name '{wantDeviceName}'");
        return false;
    }

    /// <summary>Legacy behaviour: default adapter, first output. Last resort only.</summary>
    private bool TryBuildDefault()
    {
        var result = D3D11.D3D11CreateDevice(
            null,
            DriverType.Hardware,
            DeviceCreationFlags.BgraSupport,
            FeatureLevels,
            out _device,
            out _context);
        if (result.Failure || _device is null || _context is null)
        {
            Log.Warn($"DXGI: D3D11CreateDevice failed 0x{result.Code:X8}");
            return false;
        }

        using var dxgiDevice = _device.QueryInterface<IDXGIDevice>();
        using var adapter = dxgiDevice.GetAdapter();
        if (adapter.EnumOutputs(0, out IDXGIOutput output).Failure || output is null)
        {
            Log.Warn("DXGI: default adapter exposes no outputs");
            return false;
        }
        using (output)
        {
            OutputDescription desc;
            try { desc = output.Description; }
            catch { desc = default; }
            return FinishDuplication(output, desc);
        }
    }

    /// <summary>Create the D3D11 device on <paramref name="adapter"/> and duplicate <paramref name="output"/>.</summary>
    private bool BuildFrom(IDXGIAdapter1 adapter, IDXGIOutput output, OutputDescription desc)
    {
        // A non-null adapter REQUIRES DriverType.Unknown; passing Hardware here
        // returns E_INVALIDARG and used to look like "DXGI unavailable".
        var result = D3D11.D3D11CreateDevice(
            adapter,
            DriverType.Unknown,
            DeviceCreationFlags.BgraSupport,
            FeatureLevels,
            out _device,
            out _context);
        if (result.Failure || _device is null || _context is null)
        {
            Log.Warn($"DXGI: D3D11CreateDevice(adapter) failed 0x{result.Code:X8}");
            return false;
        }
        return FinishDuplication(output, desc);
    }

    private bool FinishDuplication(IDXGIOutput output, OutputDescription desc)
    {
        if (_device is null) return false;
        using var output1 = output.QueryInterface<IDXGIOutput1>();
        _duplication = output1.DuplicateOutput(_device);

        var dupDesc = _duplication.Description;
        _width = (int)dupDesc.ModeDescription.Width;
        _height = (int)dupDesc.ModeDescription.Height;

        _deviceName = string.IsNullOrEmpty(desc.DeviceName)
            ? MonitorSelector.SelectedDeviceName
            : desc.DeviceName;
        _offsetX = desc.DesktopCoordinates.Left;
        _offsetY = desc.DesktopCoordinates.Top;
        // A zero-size mode description happens on some virtual displays; take
        // the desktop rectangle instead so the staging texture is still valid.
        if (_width <= 0 || _height <= 0)
        {
            _width = Math.Max(2, desc.DesktopCoordinates.Right - desc.DesktopCoordinates.Left);
            _height = Math.Max(2, desc.DesktopCoordinates.Bottom - desc.DesktopCoordinates.Top);
        }

        _staging = _device.CreateTexture2D(StagingDesc(_width, _height));
        _initialized = true;
        Log.Info($"DXGI: Desktop Duplication initialized {_deviceName} {_width}x{_height} " +
                 $"@ ({_offsetX},{_offsetY})");
        return true;
    }

    private static Texture2DDescription StagingDesc(int width, int height) => new()
    {
        Width = (uint)width,
        Height = (uint)height,
        MipLevels = 1u,
        ArraySize = 1u,
        Format = Vortice.DXGI.Format.B8G8R8A8_UNorm,
        SampleDescription = new SampleDescription(1, 0),
        Usage = ResourceUsage.Staging,
        BindFlags = BindFlags.None,
        CPUAccessFlags = CpuAccessFlags.Read,
        MiscFlags = ResourceOptionFlags.None,
    };

    /// <summary>
    /// Acquire the next desktop frame and return it as a BGRA <see cref="Bitmap"/>.
    /// Returns null when DXGI reports no visible change (dirty/move rect count
    /// == 0) and <paramref name="forceRefresh"/> is false — callers can then
    /// keep displaying the last frame with zero encoder cost.
    /// </summary>
    public unsafe Bitmap? TryCapture(int timeoutMs, bool forceRefresh)
    {
        if (!_initialized || _duplication is null || _device is null ||
            _context is null || _staging is null)
            return null;

        // Monitor picker changed (or the selected display was unplugged) —
        // rebuild against the new target before touching the old duplication.
        if (IsStale)
        {
            TryReinitialize($"monitor switched to {MonitorSelector.SelectedDeviceName}");
            return null;
        }

        IDXGIResource? desktopResource = null;
        ID3D11Texture2D? desktopTexture = null;
        var acquiredFrom = _duplication;
        bool frameAcquired = false;
        try
        {
            var acquire = _duplication.AcquireNextFrame((uint)timeoutMs, out var frameInfo, out desktopResource);
            if (acquire.Failure)
            {
                if (acquire.Code == unchecked((int)0x887A0027) /* DXGI_ERROR_WAIT_TIMEOUT */)
                {
                    _lastFrameChanged = false;
                    // A still desktop never produces a new frame, so a refresh
                    // that waits for one never happens. Serve the last good
                    // image from the staging texture instead.
                    return forceRefresh && _haveImage ? MapStaging() : null;
                }
                // ACCESS_LOST / DEVICE_REMOVED / DEVICE_RESET are what a
                // resolution change, a GPU driver reset, a UAC secure-desktop
                // switch or a monitor hot-plug look like from here. Before this
                // we just logged and returned null on every subsequent call —
                // the session froze on its last good frame until the agent was
                // restarted. Rebuild the duplication instead.
                if (acquire.Code == unchecked((int)0x887A0026) /* ACCESS_LOST */ ||
                    acquire.Code == unchecked((int)0x887A0005) /* DEVICE_REMOVED */ ||
                    acquire.Code == unchecked((int)0x887A0007) /* DEVICE_RESET */ ||
                    acquire.Code == unchecked((int)0x887A0004) /* UNSUPPORTED */)
                {
                    TryReinitialize($"AcquireNextFrame 0x{acquire.Code:X8}");
                    return null;
                }
                Log.Warn($"DXGI: AcquireNextFrame 0x{acquire.Code:X8}");
                return null;
            }

            frameAcquired = true;
            // Only a non-zero LastPresentTime means the desktop image was
            // updated. A mouse-only update (LastMouseUpdateTime alone) leaves
            // the texture as it was, and on a fresh duplication that texture
            // has never been written, so copying it shipped a black frame. The
            // cursor travels separately (CursorPump), so mouse moves are not
            // picture changes here.
            _lastFrameChanged = frameInfo.LastPresentTime != 0;

            if (!_lastFrameChanged)
            {
                // Nothing on screen changed — save the encode, or re-serve the
                // last good image when a refresh is due.
                return forceRefresh && _haveImage ? MapStaging() : null;
            }

            desktopTexture = desktopResource!.QueryInterface<ID3D11Texture2D>();

            // A mid-session resolution change can also arrive silently: the
            // duplication survives but hands back a differently sized texture.
            // CopyResource would then fail (or tear) — resize in place.
            var srcDesc = desktopTexture.Description;
            if ((int)srcDesc.Width != _width || (int)srcDesc.Height != _height)
            {
                Log.Info($"DXGI: source resized {_width}x{_height} -> {srcDesc.Width}x{srcDesc.Height}");
                if (!ResizeStaging((int)srcDesc.Width, (int)srcDesc.Height)) return null;
            }

            _context.CopyResource(_staging, desktopTexture);
            _haveImage = true;
            return MapStaging();
        }
        catch (SharpGenException ex)
        {
            Log.Warn($"DXGI: capture failed 0x{ex.HResult:X8} — {ex.Message}");
            return null;
        }
        catch (Exception ex)
        {
            Log.Warn($"DXGI: capture exception: {ex.Message}");
            return null;
        }
        finally
        {
            desktopTexture?.Dispose();
            desktopResource?.Dispose();
            // Never release a frame on a newly rebuilt duplication, or after
            // WAIT_TIMEOUT where AcquireNextFrame did not grant ownership.
            if (frameAcquired) { try { acquiredFrom.ReleaseFrame(); } catch { } }
        }
    }

    /// <summary>
    /// Copy the staging texture (the last captured desktop image) into a new
    /// <see cref="Bitmap"/>. Used for fresh frames and for refreshes of a
    /// still desktop alike.
    /// </summary>
    private unsafe Bitmap? MapStaging()
    {
        if (_context is null || _staging is null) return null;
        try
        {
            var map = _context.Map(_staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
            try
            {
                var bmp = new Bitmap(_width, _height, PixelFormat.Format32bppRgb);
                var rect = new Rectangle(0, 0, _width, _height);
                var bmpData = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                try
                {
                    int srcStride = (int)map.RowPitch;
                    int dstStride = bmpData.Stride;
                    // RowPitch can include driver padding. Copy only visible
                    // pixels while advancing source and destination separately.
                    int visibleRowBytes = checked(_width * 4);
                    if (srcStride < visibleRowBytes || Math.Abs(dstStride) < visibleRowBytes)
                        throw new InvalidOperationException(
                            $"DXGI row pitch too small (src={srcStride}, dst={dstStride}, visible={visibleRowBytes})");
                    for (int y = 0; y < _height; y++)
                    {
                        var src = IntPtr.Add(map.DataPointer, y * srcStride);
                        var dst = IntPtr.Add(bmpData.Scan0, y * dstStride);
                        Buffer.MemoryCopy((void*)src, (void*)dst, Math.Abs(dstStride), visibleRowBytes);
                    }
                }
                finally { bmp.UnlockBits(bmpData); }
                return bmp;
            }
            finally
            {
                _context.Unmap(_staging, 0);
            }
        }
        catch (SharpGenException ex)
        {
            Log.Warn($"DXGI: staging map failed 0x{ex.HResult:X8} — {ex.Message}");
            return null;
        }
        catch (Exception ex)
        {
            Log.Warn($"DXGI: staging map exception: {ex.Message}");
            return null;
        }
    }

    public void Dispose()
    {
        try { _duplication?.Dispose(); } catch { }
        try { _staging?.Dispose(); } catch { }
        try { _context?.Dispose(); } catch { }
        try { _device?.Dispose(); } catch { }
        _duplication = null;
        _staging = null;
        _context = null;
        _device = null;
        _initialized = false;
        _haveImage = false;
    }

    /// <summary>
    /// Rebuild the CPU-readable staging texture for a new desktop size.
    /// Called on a mid-session resolution change; never tears the D3D device
    /// down, so the encode loop keeps its cadence.
    /// </summary>
    private bool ResizeStaging(int width, int height)
    {
        if (_device is null || width <= 0 || height <= 0) return false;
        try
        {
            var old = _staging;
            _staging = _device.CreateTexture2D(StagingDesc(width, height));
            _haveImage = false;
            try { old?.Dispose(); } catch { }
            _width = width;
            _height = height;
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"DXGI: staging resize failed: {ex.Message}");
            TryReinitialize("staging resize failure");
            return false;
        }
    }

    // Don't thrash: a lost desktop (locked workstation, secure desktop) can
    // fail for many seconds; one rebuild attempt per second is plenty.
    private DateTime _lastReinitUtc = DateTime.MinValue;

    private void TryReinitialize(string why)
    {
        if ((DateTime.UtcNow - _lastReinitUtc).TotalMilliseconds < 1000) return;
        _lastReinitUtc = DateTime.UtcNow;
        Log.Warn($"DXGI: rebuilding duplication ({why})");
        Dispose();
        if (TryInitialize()) Log.Info($"DXGI: duplication rebuilt on {_deviceName}");
    }
}
