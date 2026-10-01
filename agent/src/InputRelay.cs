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
/// cancellation token — no window, tray, or stop.flag dependency: when the
/// session ends the token cancels and the relay + curtain release together.
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

        // Adaptive poll cadence. Under active input the admin drops many events
        // into session_inputs per second and we want to replay them as close to
        // real-time as the DB round-trip allows — 25ms is the tight floor. In
        // idle periods (no admin, no keystrokes) we back off toward 60ms so we
        // do not hammer PostgREST for empty result sets. The web console's
        // primary path is WebRTC DataChannel today; this poller is the belt-
        // and-braces fallback that must never miss a keystroke.
        int delayMs = 25;
        while (!ct.IsCancellationRequested)
        {
            bool sawWork = false;
            try
            {
                var (max, items) = await api.PollInputsAsync(sessionId, since, ct);
                if (items != null && items.Count > 0)
                {
                    sawWork = true;
                    // Batch-local coalescer: consecutive `mousemove` rows collapse
                    // to the latest before hitting the pump. Any non-move event
                    // (button/wheel/key/text/curtain_*) flushes the pending move
                    // first so ordering is preserved.
                    JsonElement? pendingMove = null;
                    foreach (var it in items)
                    {
                        var k = it.TryGetProperty("kind", out var kv) ? kv.GetString() : null;
                        if (k == "mousemove")
                        {
                            pendingMove = it;
                            continue;
                        }
                        if (pendingMove.HasValue)
                        {
                            try { pump.Enqueue(pendingMove.Value); } catch (Exception ex) { Log.Warn($"input enqueue: {ex.Message}"); }
                            pendingMove = null;
                        }
                        try { pump.Enqueue(it); } catch (Exception ex) { Log.Warn($"input enqueue: {ex.Message}"); }
                    }
                    if (pendingMove.HasValue)
                    {
                        try { pump.Enqueue(pendingMove.Value); } catch (Exception ex) { Log.Warn($"input enqueue: {ex.Message}"); }
                    }
                    if (max > since) since = max;
                }
            }
            catch (Exception ex) { Log.Warn($"input poll: {ex.Message}"); }
            delayMs = sawWork ? 25 : Math.Min(60, delayMs + 5);
            try { await Task.Delay(delayMs, ct); } catch { }

        }
    }

    // Security: every inbound message is treated as hostile. Only the closed
    // set of kinds below is honoured; all numbers are clamped and text is
    // length-capped before reaching Win32. Nothing here can launch a process.
    private const int MaxTextChars = 256;
    private const int MaxRelDelta = 500;
    private const int MaxWheel = 1200;
    private const int MaxSequenceEvents = 32;

    internal static void Apply(JsonElement it)
    {
        if (it.ValueKind != JsonValueKind.Object) return;
        if (!it.TryGetProperty("kind", out var kv) || kv.ValueKind != JsonValueKind.String) return;
        var kind = kv.GetString();
        var p = it.TryGetProperty("payload", out var pv) && pv.ValueKind == JsonValueKind.Object ? pv : default;
        try
        {
            switch (kind)
            {
                case "mousemove": MoveTo(Math.Clamp(GetD(p, "x"), 0.0, 1.0), Math.Clamp(GetD(p, "y"), 0.0, 1.0)); break;
                case "mousemove_rel": MoveRel(Math.Clamp(GetInt(p, "dx"), -MaxRelDelta, MaxRelDelta), Math.Clamp(GetInt(p, "dy"), -MaxRelDelta, MaxRelDelta)); break;
                case "click": Click(Math.Clamp(GetInt(p, "button"), 0, 2)); break;
                case "mousedown": MouseButton(Math.Clamp(GetInt(p, "button"), 0, 2), true); break;
                case "mouseup": MouseButton(Math.Clamp(GetInt(p, "button"), 0, 2), false); break;
                case "wheel": Wheel(Math.Clamp(GetInt(p, "dy"), -MaxWheel, MaxWheel)); break;
                case "keydown": { var vk = GetInt(p, "vk"); if (IsValidVk(vk)) Key(vk, true); break; }
                case "keyup": { var vk = GetInt(p, "vk"); if (IsValidVk(vk)) Key(vk, false); break; }
                case "key_sequence": KeySequence(p); break;
                case "unicode_text":
                case "text": InjectUnicodeString(CapText(GetString(p, "text"))); break;
                case "curtain_on": EngageCurtain(); break;
                case "curtain_off": ReleaseCurtain(); break;
                case "release_inputs": ReleaseCurtain(); break;
                default: Log.Warn($"input: rejected unknown kind '{Truncate(kind, 32)}'"); break;
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            Log.Warn($"input: malformed '{Truncate(kind, 32)}' payload rejected");
        }
    }

    private static bool IsValidVk(int vk) => vk is > 0 and < 0xFF;

    private static string CapText(string s) => s.Length > MaxTextChars ? s.Substring(0, MaxTextChars) : s;

    private static string Truncate(string? s, int n) => s is null ? "" : (s.Length > n ? s.Substring(0, n) : s);

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
                CurtainOverlay.Show();
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


    private static double GetD(JsonElement o, string k)
    {
        if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(k, out var v) || v.ValueKind != JsonValueKind.Number) return 0;
        var d = v.GetDouble();
        return double.IsFinite(d) ? d : 0;
    }
    private static int GetInt(JsonElement o, string k)
    {
        if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(k, out var v) || v.ValueKind != JsonValueKind.Number) return 0;
        return v.TryGetInt32(out var i) ? i : 0;
    }
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
        int n = 0;
        foreach (var ev in events.EnumerateArray())
        {
            if (++n > MaxSequenceEvents) { Log.Warn("input: key_sequence truncated"); break; }
            var vk = GetInt(ev, "vk");
            var down = ev.ValueKind == JsonValueKind.Object && ev.TryGetProperty("down", out var d) && d.ValueKind == JsonValueKind.True;
            if (!IsValidVk(vk)) continue;
            Key(vk, down);
            Thread.Sleep(10);
        }
    }
}
