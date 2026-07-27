using System;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace ConnectLive.Admin.Media;

/// <summary>
/// WPF D3DImage host — future entry point for hardware-decoded H.264 frames.
///
/// STA guardrail: SIPSorcery / Media Foundation raise "sample ready" events on
/// worker threads. WPF's D3DImage requires Lock / SetBackBuffer / AddDirtyRect /
/// Unlock to run on the UI dispatcher. Every PushFrame call is therefore
/// marshaled via <see cref="Application.Current.Dispatcher"/>.
///
/// Today the live view uses the JPEG fallback pump; this host is wired but idle
/// until the Media Foundation decoder is plugged into <see cref="WebRtcClient"/>.
/// Keeping the scaffold in place means the plug-in change is small and safe.
/// </summary>
public sealed class D3DImageHost
{
    public D3DImage Image { get; } = new D3DImage();

    /// <summary>
    /// Hand the host a fresh IDirect3DSurface9 pointer produced by the decoder.
    /// Safe to call from any thread; the method returns immediately.
    /// </summary>
    public void PushFrame(IntPtr backBuffer, int width, int height)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher == null) return;
        if (dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished) return;

        if (dispatcher.CheckAccess())
        {
            ApplyOnUi(backBuffer, width, height);
            return;
        }

        // BeginInvoke over InvokeAsync: we prefer to drop late frames rather
        // than back-pressure the decoder thread. If the dispatcher is torn down
        // mid-close, swallow — the session is ending anyway.
        try
        {
            dispatcher.BeginInvoke(new Action(() => ApplyOnUi(backBuffer, width, height)),
                DispatcherPriority.Render);
        }
        catch (TaskCanceledException) { }
        catch (InvalidOperationException) { }
    }

    private void ApplyOnUi(IntPtr backBuffer, int width, int height)
    {
        try
        {
            Image.Lock();
            Image.SetBackBuffer(D3DResourceType.IDirect3DSurface9, backBuffer);
            Image.AddDirtyRect(new Int32Rect(0, 0, width, height));
        }
        catch (Exception)
        {
            // Decoder surface may have been released between marshal and apply.
        }
        finally
        {
            try { Image.Unlock(); } catch { }
        }
    }
}
