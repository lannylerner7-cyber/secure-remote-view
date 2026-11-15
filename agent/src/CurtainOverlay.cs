using System;
using System.Collections.Generic;
using System.Windows.Forms;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Full-screen "maintenance in progress" curtain covering every attached
/// monitor. Excluded from screen capture via SetWindowDisplayAffinity so
/// the admin's stream stays clean while the physical user sees the notice.
///
/// The overlay is display-only: physical input is disabled at the OS layer
/// by an ordinary-desktop input filter. It neither elevates nor replaces
/// Windows security boundaries. Capture exclusion requires Windows testing.
/// </summary>
public sealed class CurtainOverlay
{
    private static readonly CurtainDisplaySession Display = new(CreateSurfaces);

    // Includes the interval before the first Show and until every window is
    // hidden. Capture must not mistake partial activation/teardown for "off".
    public static bool IsShown => Display.IsShown;

    internal static async Task<CurtainApplyResult> ShowRenderedAsync()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
            return Report(CurtainApplyResult.Failed("unsupported_windows"));

        var composition = CurtainNative.CheckComposition();
        if (!composition.Applied)
        {
            Hide();
            return Report(composition);
        }
        // The controller calls on the existing WPF dispatcher. The forms use
        // that message pump; there is no second UI thread or Application.Run.
        return Report(await Display.ShowRenderedAsync());
    }

    public static void Hide()
    {
        Display.Hide();
        if (Display.IsShown)
            Log.Warn("curtain cleanup unconfirmed; unsafe capture remains blocked");
    }

    internal static bool TryCaptureWithoutCurtain(Action capture) => Display.TryRunWhileHidden(capture);

    private static IEnumerable<ICurtainSurface> CreateSurfaces()
    {
        foreach (var screen in Screen.AllScreens)
            yield return new CurtainForm(screen.Bounds);
    }

    private static CurtainApplyResult Report(CurtainApplyResult result)
    {
        if (!result.Applied)
            Log.Warn($"curtain display rejected: reason={result.Reason} native_error={result.NativeError}");
        else
            Log.Info($"curtain display ready: windows={Display.WindowCount} exstyle_required=0x{CurtainNative.RequiredExStyles:X8} affinity=0x11");
        return result;
    }
}
