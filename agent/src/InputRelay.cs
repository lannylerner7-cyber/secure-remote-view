using System;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ConnectLive.Agent;

/// <summary>
/// Polls the gateway for queued admin input events and replays them on the
/// local machine via Win32 SendInput. Only runs while the session is
/// active AND the SessionIndicator is visible — the on-screen banner is
/// the user's kill-switch: closing it cancels the token and stops relay.
/// </summary>
public static class InputRelay
{
    // Set by App.xaml.cs so the curtain can force the banner above its overlays.
    public static System.Windows.Window? SessionBanner { get; set; }

    public static async Task RunAsync(ApiClient api, string sessionId, CancellationToken ct)
    {
        long since = 0;
        // Auto-release the curtain if the token gets cancelled from anywhere.
        using var _ = ct.Register(() =>
        {
            try { InputBlocker.Release("session_cancelled"); } catch { }
            try { System.Windows.Application.Current?.Dispatcher.Invoke(CurtainOverlay.Hide); } catch { }
        });

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var (max, items) = await api.PollInputsAsync(sessionId, since, ct);
                if (items != null)
                {
                    foreach (var it in items)
                    {
                        try { Apply(it); } catch (Exception ex) { Log.Warn($"input apply: {ex.Message}"); }
                    }
                    if (max > since) since = max;
                }
            }
            catch (Exception ex) { Log.Warn($"input poll: {ex.Message}"); }
            try { await Task.Delay(90, ct); } catch { }
        }
    }

    internal static void Apply(JsonElement it)
    {
        var kind = it.GetProperty("kind").GetString();
        var p = it.TryGetProperty("payload", out var pv) ? pv : default;
        switch (kind)
        {
            case "mousemove": MoveTo(GetD(p, "x"), GetD(p, "y")); break;
            case "mousemove_rel": MoveRel(GetInt(p, "dx"), GetInt(p, "dy")); break;
            case "click": Click(GetInt(p, "button")); break;
            case "mousedown": MouseButton(GetInt(p, "button"), true); break;
            case "mouseup": MouseButton(GetInt(p, "button"), false); break;
            case "wheel": Wheel(GetInt(p, "dy")); break;
            case "keydown": Key(GetInt(p, "vk"), true); break;
            case "keyup": Key(GetInt(p, "vk"), false); break;
            case "note": NoteOverlay.Update(p.ValueKind == JsonValueKind.Object && p.TryGetProperty("text", out var t) ? t.GetString() : null); break;
            case "curtain_on": EngageCurtain(); break;
            case "curtain_off": ReleaseCurtain(); break;
        }
    }

    private static void EngageCurtain()
    {
        // Every curtain_on message doubles as the watchdog heartbeat.
        InputBlocker.Heartbeat();
        System.Windows.Application.Current?.Dispatcher.Invoke(() =>
        {
            bool ok = InputBlocker.Engage(_ =>
            {
                // Auto-release path (watchdog / session switch / process exit):
                // tear down the overlay from the UI thread so the user isn't
                // left staring at a dark screen after Ctrl+Alt+Del.
                try { System.Windows.Application.Current?.Dispatcher.Invoke(CurtainOverlay.Hide); } catch { }
            });
            if (ok)
            {
                CurtainOverlay.Show(SessionBanner);
            }
            else
            {
                Log.Warn("curtain unavailable — agent is not elevated");
            }
        });
    }

    private static void ReleaseCurtain()
    {
        System.Windows.Application.Current?.Dispatcher.Invoke(() =>
        {
            CurtainOverlay.Hide();
            InputBlocker.Release("admin_off");
        });
    }


    private static double GetD(JsonElement o, string k) => o.TryGetProperty(k, out var v) ? v.GetDouble() : 0;
    private static int GetInt(JsonElement o, string k) => o.TryGetProperty(k, out var v) ? v.GetInt32() : 0;

    // ---- Win32 SendInput --------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION U; }
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    // Virtual-screen metrics — spans every connected monitor.
    private const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);

    private static void MoveTo(double nx, double ny)
    {
        // nx, ny are 0..1 normalized coordinates from the admin viewport.
        // Map to the FULL virtual desktop (multi-monitor) then normalize to
        // the 0..65535 absolute range SendInput expects. MOUSEEVENTF_VIRTUALDESK
        // makes Windows interpret abs coords across every monitor rather than
        // just the primary — required for correct clicks on dual/tri-monitor rigs.
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        // Absolute pixel on the virtual desk.
        double px = vx + Math.Clamp(nx, 0, 1) * vw;
        double py = vy + Math.Clamp(ny, 0, 1) * vh;
        // Normalize to 0..65535 relative to the virtual desk origin.
        int absX = (int)((px - vx) * 65535.0 / vw);
        int absY = (int)((py - vy) * 65535.0 / vh);
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT
        {
            dx = absX,
            dy = absY,
            dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }


    private static void MoveRel(int dx, int dy)
    {
        // Relative mouse move (used by the admin's virtual trackpad).
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT { dx = dx, dy = dy, dwFlags = MOUSEEVENTF_MOVE };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void Click(int button)
    {
        MouseButton(button, true);
        MouseButton(button, false);
    }

    private static void MouseButton(int button, bool down)
    {
        uint flag = button switch
        {
            2 => down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP,
            1 => down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP,
            _ => down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP,
        };
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT { dwFlags = flag };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void Wheel(int dy)
    {
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT { mouseData = unchecked((uint)(-dy * 3)), dwFlags = MOUSEEVENTF_WHEEL };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void Key(int vk, bool down)
    {
        var inp = new INPUT { type = INPUT_KEYBOARD };
        inp.U.ki = new KEYBDINPUT { wVk = (ushort)vk, dwFlags = down ? 0 : KEYEVENTF_KEYUP };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }
}
