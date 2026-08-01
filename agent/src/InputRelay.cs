using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ConnectLive.Agent;

/// <summary>
/// Polls the gateway for queued admin input events and replays them on the
/// local machine via Win32 SendInput. The loop lives entirely on the session
/// cancellation token: when the session ends (or the user quits from the tray
/// / stop.flag), the token cancels and the relay + curtain release together.
/// There is no on-screen banner — the tray icon carries session transparency.
/// </summary>
public static class InputRelay
{

    public static async Task RunAsync(ApiClient api, string sessionId, CancellationToken ct)
    {
        long since = 0;
        using var pump = new InputPump();
        // Auto-release the curtain if the token gets cancelled from anywhere.
        using var _ = ct.Register(() =>
        {
            try { pump.Release("session_cancelled"); } catch { }
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
                        try { pump.Enqueue(it); } catch (Exception ex) { Log.Warn($"input enqueue: {ex.Message}"); }
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
            case "key_sequence": KeySequence(p); break;
            case "unicode_text": InjectUnicodeString(GetString(p, "text")); break;
            case "text": InjectUnicodeString(GetString(p, "text")); break;
            
            case "curtain_on": EngageCurtain(); break;
            case "curtain_off": ReleaseCurtain(); break;
            case "release_inputs": ReleaseCurtain(); break;
        }
    }

    private sealed class InputPump : IDisposable
    {
        private readonly BlockingCollection<Action> _queue = new(new ConcurrentQueue<Action>());
        private readonly Thread _thread;

        public InputPump()
        {
            _thread = new Thread(Run) { IsBackground = true, Name = "connectlive-input-pump" };
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();
        }

        public void Enqueue(JsonElement item)
        {
            var clone = item.Clone();
            _queue.Add(() => Apply(clone));
        }

        public void Release(string reason)
        {
            if (!_queue.IsAddingCompleted)
                _queue.Add(() => ReleaseCurtain(reason));
        }

        private void Run()
        {
            try
            {
                while (!_queue.IsCompleted)
                {
                    try
                    {
                        if (_queue.TryTake(out var action, 250)) action();
                        if (InputBlocker.CheckWatchdog(TimeSpan.FromSeconds(5)))
                            HideCurtainOnUiThread();
                    }
                    catch (InvalidOperationException) { break; }
                    catch (Exception ex) { Log.Warn($"input pump: {ex.Message}"); }
                }
            }
            finally
            {
                try { InputBlocker.Release("input_pump_exit"); } catch { }
                HideCurtainOnUiThread();
            }
        }

        public void Dispose()
        {
            try { Release("session_disposed"); } catch { }
            try { _queue.CompleteAdding(); } catch { }
            if (!_thread.Join(2000))
            {
                try { InputBlocker.Release("dispose_timeout"); } catch { }
                HideCurtainOnUiThread();
            }
            _queue.Dispose();
        }
    }

    private static void EngageCurtain()
    {
        // Every curtain_on message doubles as the watchdog heartbeat.
        InputBlocker.Heartbeat();
        bool ok = InputBlocker.Engage(_ => HideCurtainOnUiThread());
        if (ok)
        {
            System.Windows.Application.Current?.Dispatcher.Invoke(() =>
            {
                CurtainOverlay.Show(SessionBanner);
            });
        }
        else
        {
            Log.Warn("curtain unavailable — agent is not elevated");
        }
    }

    private static void ReleaseCurtain()
    {
        ReleaseCurtain("admin_off");
    }

    private static void ReleaseCurtain(string reason)
    {
        InputBlocker.Release(reason);
        HideCurtainOnUiThread();
    }

    private static void HideCurtainOnUiThread()
    {
        System.Windows.Application.Current?.Dispatcher.Invoke(() =>
        {
            CurtainOverlay.Hide();
        });
    }


    private static double GetD(JsonElement o, string k) => o.TryGetProperty(k, out var v) ? v.GetDouble() : 0;
    private static int GetInt(JsonElement o, string k) => o.TryGetProperty(k, out var v) ? v.GetInt32() : 0;
    private static string GetString(JsonElement o, string k) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? string.Empty
            : string.Empty;

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
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    // Virtual-keys that MUST carry the extended-key flag or Windows treats
    // them as their numpad twins (arrows become "5"/nothing when NumLock is
    // off, so the cursor never moves in the remote app). Covers arrows,
    // navigation cluster, and right-hand modifiers.
    private static bool IsExtendedKey(int vk) => vk switch
    {
        0x21 or 0x22 or 0x23 or 0x24 => true,          // PgUp, PgDn, End, Home
        0x25 or 0x26 or 0x27 or 0x28 => true,          // Left, Up, Right, Down
        0x2D or 0x2E => true,                          // Insert, Delete
        0x5B or 0x5C or 0x5D => true,                  // LWin, RWin, Apps
        0x6F => true,                                  // Numpad divide
        0x0D => false,                                 // Enter (numpad-enter would need it; main Enter does not)
        _ => false,
    };

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
            dwExtraInfo = InputBlocker.CONNECTLIVE_INPUT_MAGIC,
        };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }


    private static void MoveRel(int dx, int dy)
    {
        // Relative mouse move (used by the admin's virtual trackpad).
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT
        {
            dx = dx,
            dy = dy,
            dwFlags = MOUSEEVENTF_MOVE,
            dwExtraInfo = InputBlocker.CONNECTLIVE_INPUT_MAGIC,
        };
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
        inp.U.mi = new MOUSEINPUT { dwFlags = flag, dwExtraInfo = InputBlocker.CONNECTLIVE_INPUT_MAGIC };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void Wheel(int dy)
    {
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT
        {
            mouseData = unchecked((uint)(-dy * 3)),
            dwFlags = MOUSEEVENTF_WHEEL,
            dwExtraInfo = InputBlocker.CONNECTLIVE_INPUT_MAGIC,
        };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void Key(int vk, bool down)
    {
        uint flags = down ? 0u : KEYEVENTF_KEYUP;
        if (IsExtendedKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        var inp = new INPUT { type = INPUT_KEYBOARD };
        inp.U.ki = new KEYBDINPUT
        {
            wVk = (ushort)vk,
            dwFlags = flags,
            dwExtraInfo = InputBlocker.CONNECTLIVE_INPUT_MAGIC,
        };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void InjectUnicodeString(string text)
    {
        if (string.IsNullOrEmpty(text)) return;

        // Send Unicode scan codes directly so text entry does not depend on
        // keyboard layout, Shift state, or physical key mapping. Windows apps
        // receive exactly these UTF-16 code units in the currently focused field.
        const int chunkChars = 128;
        for (int offset = 0; offset < text.Length; offset += chunkChars)
        {
            int count = Math.Min(chunkChars, text.Length - offset);
            var inputs = new INPUT[count * 2];
            int index = 0;
            for (int i = 0; i < count; i++)
            {
                ushort ch = (ushort)text[offset + i];

                var down = new INPUT { type = INPUT_KEYBOARD };
                down.U.ki = new KEYBDINPUT
                {
                    wVk = 0,
                    wScan = ch,
                    dwFlags = KEYEVENTF_UNICODE,
                    dwExtraInfo = InputBlocker.CONNECTLIVE_INPUT_MAGIC,
                };
                inputs[index++] = down;

                var up = new INPUT { type = INPUT_KEYBOARD };
                up.U.ki = new KEYBDINPUT
                {
                    wVk = 0,
                    wScan = ch,
                    dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    dwExtraInfo = InputBlocker.CONNECTLIVE_INPUT_MAGIC,
                };
                inputs[index++] = up;
            }

            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
            Thread.Sleep(1);
        }
    }

    private static void KeySequence(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("events", out var events) || events.ValueKind != JsonValueKind.Array)
            return;
        foreach (var ev in events.EnumerateArray())
        {
            var vk = GetInt(ev, "vk");
            var down = ev.TryGetProperty("down", out var d) && d.GetBoolean();
            if (vk <= 0) continue;
            Key(vk, down);
            Thread.Sleep(10);
        }
    }
}
