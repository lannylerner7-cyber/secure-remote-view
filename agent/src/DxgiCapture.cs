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
/// Dependencies: Vortice.Direct3D11 + Vortice.DXGI (pure-managed, single-file
/// publish safe, MIT). Chosen over SharpDX because SharpDX is unmaintained
/// and its native COM interop breaks under net8 single-file trimming.
/// </summary>
public sealed class DxgiCapture : IDisposable
{
    private IDXGIOutputDuplication? _duplication;
    private ID3D11Device? _device;
    private ID3D11DeviceContext? _context;
    private ID3D11Texture2D? _staging;
    private int _width;
    private int _height;
    private bool _initialized;
    private bool _lastFrameChanged;
    private readonly Stopwatch _sw = new();

    public bool IsInitialized => _initialized;
    public bool LastFrameHadContentChange => _lastFrameChanged;
    public int Width => _width;
    public int Height => _height;

    public bool TryInitialize()
    {
        try
        {
            // Create D3D11 device on the default adapter. BgraSupport is
            // required for CPU-visible staging textures.
            var result = D3D11.D3D11CreateDevice(
                adapter: null,
                DriverType.Hardware,
                DeviceCreationFlags.BgraSupport,
                new[] { FeatureLevel.Level_11_0, FeatureLevel.Level_10_1, FeatureLevel.Level_10_0 },
                out _device,
                out _context);
            if (result.Failure || _device is null || _context is null)
            {
                Log.Warn($"DXGI: D3D11CreateDevice failed 0x{result.Code:X8}");
                return false;
            }

            using var dxgiDevice = _device.QueryInterface<IDXGIDevice>();
            using var adapter = dxgiDevice.GetAdapter();
            using var output = adapter.GetOutput(0);
            using var output1 = output.QueryInterface<IDXGIOutput1>();

            _duplication = output1.DuplicateOutput(_device);
            var desc = _duplication.Description;
            _width = desc.ModeDesc.Width;
            _height = desc.ModeDesc.Height;

            // Staging texture matches the duplication surface, CPU-readable.
            var stagingDesc = new Texture2DDescription
            {
                Width = _width,
                Height = _height,
                MipLevels = 1,
                ArraySize = 1,
                Format = Vortice.DXGI.Format.B8G8R8A8_UNorm,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Staging,
                BindFlags = BindFlags.None,
                CPUAccessFlags = CpuAccessFlags.Read,
                MiscFlags = ResourceOptionFlags.None,
            };
            _staging = _device.CreateTexture2D(stagingDesc);

            _initialized = true;
            Log.Info($"DXGI: Desktop Duplication initialized {_width}x{_height}");
            return true;
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


        IDXGIResource? desktopResource = null;
        ID3D11Texture2D? desktopTexture = null;
        try
        {
            var acquire = _duplication.AcquireNextFrame(timeoutMs, out var frameInfo, out desktopResource);
            if (acquire.Failure)
            {
                if (acquire.Code == unchecked((int)0x887A0027) /* DXGI_ERROR_WAIT_TIMEOUT */)
                {
                    _lastFrameChanged = false;
                    return null;
                }
                Log.Warn($"DXGI: AcquireNextFrame 0x{acquire.Code:X8}");
                return null;
            }

            _lastFrameChanged = frameInfo.TotalMetadataBufferSize > 0 ||
                                frameInfo.LastMouseUpdateTime > 0;

            if (!_lastFrameChanged && !forceRefresh)
            {
                return null; // nothing on screen changed — save the encode.
            }

            desktopTexture = desktopResource!.QueryInterface<ID3D11Texture2D>();
            _context.CopyResource(_staging, desktopTexture);

            var map = _context.Map(_staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
            try
            {
                var bmp = new Bitmap(_width, _height, PixelFormat.Format32bppArgb);
                var rect = new Rectangle(0, 0, _width, _height);
                var bmpData = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    int srcStride = map.RowPitch;
                    int dstStride = bmpData.Stride;
                    int copyBytes = Math.Min(srcStride, dstStride);
                    for (int y = 0; y < _height; y++)
                    {
                        var src = IntPtr.Add(map.DataPointer, y * srcStride);
                        var dst = IntPtr.Add(bmpData.Scan0, y * dstStride);
                        Buffer.MemoryCopy((void*)src, (void*)dst, dstStride, copyBytes);
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
            try { _duplication?.ReleaseFrame(); } catch { }
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
    }

}

