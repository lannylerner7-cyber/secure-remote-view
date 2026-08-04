using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace ConnectLive.Agent;

/// <summary>
/// SCOPE:CAPTURE — the single source of truth for "which monitor are we
/// streaming?".
///
/// Before this existed, three subsystems each answered that question their own
/// way and disagreed on any machine where DXGI output 0 is not the Windows
/// primary display:
///   • <see cref="DxgiCapture"/> hardcoded <c>EnumOutputs(0)</c>
///   • <see cref="CursorPump"/> used <c>Screen.PrimaryScreen.Bounds</c>
///   • <see cref="ScreenCapture"/> (GDI fallback) used <c>Screen.PrimaryScreen.Bounds</c>
/// The result: pixels from one monitor, cursor coordinates from another, and
/// clicks landing at an offset.
///
/// Everything now goes through here. The selection is expressed as a Windows
/// *device name* (<c>\\.\DISPLAY1</c>) because that string is the only stable
/// join between <see cref="Screen"/> (WinForms / GDI / cursor math) and
/// <c>DXGI_OUTPUT_DESC.DeviceName</c> (Desktop Duplication). Indices are NOT
/// interchangeable between the two APIs — never assume they are.
///
/// <see cref="Outputs"/> is exposed so the admin console can eventually render
/// a monitor picker; <see cref="Select"/> is the setter it will call.
/// </summary>
public static class MonitorSelector
{
    /// <summary>One selectable display.</summary>
    public sealed record MonitorInfo(
        int Index,
        string DeviceName,
        string Label,
        Rectangle Bounds,
        bool IsPrimary);

    private static readonly object _gate = new();

    /// <summary>Device name of the monitor to capture. Null = follow the primary.</summary>
    private static string? _selectedDeviceName;

    /// <summary>Raised when the selection changes so capture can rebuild.</summary>
    public static event Action? SelectionChanged;

    /// <summary>Currently selected device name, resolved against live hardware.</summary>
    public static string SelectedDeviceName => Resolve().DeviceName;

    /// <summary>Desktop-coordinate bounds of the captured monitor (origin included).</summary>
    public static Rectangle SelectedBounds => Resolve().Bounds;

    /// <summary>Zero-based <see cref="Screen.AllScreens"/> index of the captured monitor.</summary>
    public static int SelectedIndex => Resolve().Index;

    /// <summary>True when no explicit pick has been made (we track the primary).</summary>
    public static bool IsAuto
    {
        get { lock (_gate) return _selectedDeviceName is null; }
    }

    /// <summary>Every attached display, in <see cref="Screen.AllScreens"/> order.</summary>
    public static IReadOnlyList<MonitorInfo> Outputs()
    {
        var screens = Screen.AllScreens;
        var list = new List<MonitorInfo>(screens.Length);
        for (int i = 0; i < screens.Length; i++)
        {
            var s = screens[i];
            var name = string.IsNullOrEmpty(s.DeviceName) ? $@"\\.\DISPLAY{i + 1}" : s.DeviceName;
            list.Add(new MonitorInfo(
                Index: i,
                DeviceName: name,
                Label: $"Display {i + 1} — {s.Bounds.Width}×{s.Bounds.Height}{(s.Primary ? " (primary)" : "")}",
                Bounds: s.Bounds,
                IsPrimary: s.Primary));
        }
        if (list.Count == 0)
        {
            // Session 0 / no attached display: keep the pipeline alive with a
            // sane virtual surface rather than throwing out of the capture loop.
            // S17 — prefer the real virtual-desktop metrics even here; only a
            // machine that reports no geometry at all gets the 1080p guess.
            var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
            var virt = vs.Width > 0 && vs.Height > 0 ? vs : new Rectangle(0, 0, 1920, 1080);
            list.Add(new MonitorInfo(0, @"\\.\DISPLAY1",
                $"Display 1 — {virt.Width}×{virt.Height} (virtual)", virt, true));
        }
        return list;
    }

    /// <summary>
    /// Pick a monitor by device name. Pass null (or an unknown name) to fall
    /// back to "follow the primary". Returns true when the selection changed.
    /// </summary>
    public static bool Select(string? deviceName)
    {
        string? normalized = string.IsNullOrWhiteSpace(deviceName) ? null : deviceName!.Trim();
        if (normalized is not null &&
            !Outputs().Any(o => string.Equals(o.DeviceName, normalized, StringComparison.OrdinalIgnoreCase)))
        {
            Log.Warn($"monitor: unknown display '{normalized}' — staying on {SelectedDeviceName}");
            return false;
        }

        bool changed;
        lock (_gate)
        {
            changed = !string.Equals(_selectedDeviceName, normalized, StringComparison.OrdinalIgnoreCase);
            _selectedDeviceName = normalized;
        }
        if (changed)
        {
            Log.Info($"monitor: capture target -> {SelectedDeviceName} {SelectedBounds}");
            try { SelectionChanged?.Invoke(); } catch { }
        }
        return changed;
    }

    /// <summary>Pick a monitor by <see cref="Screen.AllScreens"/> index.</summary>
    public static bool SelectByIndex(int index)
    {
        var outputs = Outputs();
        if (index < 0 || index >= outputs.Count) return Select(null);
        return Select(outputs[index].DeviceName);
    }

    /// <summary>
    /// Resolve the live monitor for the current selection. Always safe: a
    /// display that was unplugged mid-session silently degrades to the primary
    /// instead of leaving capture pointed at a rectangle that no longer exists.
    /// </summary>
    public static MonitorInfo Resolve()
    {
        var outputs = Outputs();
        string? want;
        lock (_gate) want = _selectedDeviceName;

        if (want is not null)
        {
            foreach (var o in outputs)
                if (string.Equals(o.DeviceName, want, StringComparison.OrdinalIgnoreCase))
                    return o;
            // Selected monitor vanished (undocked, hot-unplugged). Drop back to
            // auto so the very next frame comes from a display that exists.
            lock (_gate) _selectedDeviceName = null;
            Log.Warn($"monitor: '{want}' is gone — reverting to primary");
        }

        foreach (var o in outputs)
            if (o.IsPrimary) return o;
        return outputs[0];
    }
}
