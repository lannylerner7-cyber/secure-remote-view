using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;

namespace ConnectLive.Unlock;

/// <summary>Fixed Winlogon desktop only. No ordinary-desktop or UAC injection.</summary>
internal sealed class DesktopInput(int session) : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public Union Data; }
    [StructLayout(LayoutKind.Explicit)]
    private struct Union { [FieldOffset(0)] public Mouse Mouse; [FieldOffset(0)] public Key Key; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Mouse { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Key { public ushort Vk, Scan; public uint Flags, Time; public IntPtr Extra; }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
    private readonly HashSet<ushort> _held = new();
    private readonly HashSet<int> _buttons = new();
    private void Send(Input value)
    {
        if (!DesktopHost.OnLockedDesktop(session)) throw new IOException("unlock_desktop_changed");
        if (SendInput(1, new[] { value }, Marshal.SizeOf<Input>()) != 1) throw new IOException("unlock_input_rejected");
    }
    private void Keyboard(ushort key, bool down, bool unicode = false)
    {
        if (!unicode) { if (down) _held.Add(key); else _held.Remove(key); }
        var extended = !unicode && (key is 0x21 or 0x22 or 0x23 or 0x24 or 0x25 or 0x26 or 0x27 or 0x28 or 0x2D or 0x2E);
        Send(new Input { Type = 1, Data = new Union { Key = new Key {
            Vk = unicode ? (ushort)0 : key, Scan = unicode ? key : (ushort)0,
            Flags = (down ? 0u : 2u) | (unicode ? 4u : 0u) | (extended ? 1u : 0u),
        } } });
    }
    internal void Apply(JsonElement input)
    {
        if (!DesktopHost.OnLockedDesktop(session)) throw new IOException("unlock_desktop_changed");
        var kind = input.GetProperty("kind").GetString();
        var p = input.GetProperty("payload");
        if (kind is "keydown" or "keyup")
        {
            int key = p.GetProperty("vk").GetInt32();
            if (key is < 1 or > 254) throw new IOException("unlock_input_invalid");
            Keyboard((ushort)key, kind == "keydown");
        }
        else if (kind is "unicode_text" or "text")
        {
            var text = p.GetProperty("text").GetString() ?? "";
            if (text.Length > 127) throw new IOException("unlock_input_invalid");
            foreach (var ch in text) { Keyboard(ch, true, true); Keyboard(ch, false, true); }
        }
        else if (kind == "mousemove")
        {
            var x = p.GetProperty("x").GetDouble(); var y = p.GetProperty("y").GetDouble();
            if (!double.IsFinite(x) || !double.IsFinite(y)) throw new IOException("unlock_input_invalid");
            int vx = DesktopHost.GetSystemMetrics(76), vy = DesktopHost.GetSystemMetrics(77);
            int vw = Math.Max(1, DesktopHost.GetSystemMetrics(78)), vh = Math.Max(1, DesktopHost.GetSystemMetrics(79));
            int px = (int)(Math.Clamp(x, 0, 1) * Math.Max(1, DesktopHost.GetSystemMetrics(0) - 1));
            int py = (int)(Math.Clamp(y, 0, 1) * Math.Max(1, DesktopHost.GetSystemMetrics(1) - 1));
            Send(new Input { Data = new Union { Mouse = new Mouse {
                X = (int)((long)(px - vx) * 65535 / vw), Y = (int)((long)(py - vy) * 65535 / vh),
                Flags = 0x0001 | 0x8000 | 0x4000,
            } } });
        }
        else if (kind == "mousemove_rel")
        {
            var dx = p.GetProperty("dx").GetDouble(); var dy = p.GetProperty("dy").GetDouble();
            if (!double.IsFinite(dx) || !double.IsFinite(dy)) throw new IOException("unlock_input_invalid");
            Send(new Input { Data = new Union { Mouse = new Mouse {
                X = (int)Math.Clamp(Math.Round(dx), -10000, 10000),
                Y = (int)Math.Clamp(Math.Round(dy), -10000, 10000), Flags = 0x0001,
            } } });
        }
        else if (kind == "wheel")
        {
            var dy = p.GetProperty("dy").GetDouble();
            if (!double.IsFinite(dy)) throw new IOException("unlock_input_invalid");
            var delta = (int)Math.Clamp(-Math.Round(dy), -1200, 1200);
            if (delta != 0) Send(new Input { Data = new Union { Mouse = new Mouse {
                Data = unchecked((uint)delta), Flags = 0x0800,
            } } });
        }
        else if (kind is "mousedown" or "mouseup" or "click")
        {
            int button = p.GetProperty("button").GetInt32();
            if (button is < 0 or > 2) throw new IOException("unlock_input_invalid");
            if (kind is "mousedown" or "click") Button(button, true);
            if (kind is "mouseup" or "click") Button(button, false);
        }
        else if (kind == "release_inputs") Dispose();
        else throw new IOException("unlock_input_invalid");
    }
    private void Button(int button, bool down)
    {
        if (down) _buttons.Add(button); else _buttons.Remove(button);
        uint flags = button == 0 ? (down ? 2u : 4u) : button == 2 ? (down ? 8u : 16u) : (down ? 32u : 64u);
        Send(new Input { Data = new Union { Mouse = new Mouse { Flags = flags } } });
    }
    private bool IsCredentialField()
    {
        if (!DesktopHost.OnLockedDesktop(session)) return false;
        try
        {
            var field = AutomationElement.FocusedElement;
            if (field == null || !field.Current.IsPassword || !field.Current.IsEnabled) return false;
            using var process = Process.GetProcessById(field.Current.ProcessId);
            return process.SessionId == session &&
                string.Equals(process.MainModule?.FileName,
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "LogonUI.exe"),
                    StringComparison.OrdinalIgnoreCase) &&
                UnlockPipe.ProcessSid(process) == "S-1-5-18";
        }
        catch { return false; }
    }
    internal void Pin(byte[] utf8)
    {
        if (utf8.Length is < 4 or > 127 || utf8.Any(b => b is < 32 or > 126) || !IsCredentialField())
            throw new IOException("unlock_pin_field_not_verified");
        // The operator must select the correct Windows Hello PIN field first.
        // Never guess focus, select an account or click through Windows prompts.
        foreach (var b in utf8)
        {
            if (!IsCredentialField()) throw new IOException("unlock_pin_field_changed");
            Keyboard((char)b, true, true);
            Keyboard((char)b, false, true);
        }
        // Hello may submit automatically. Never type Enter after unlock.
        if (IsCredentialField()) { Keyboard(0x0D, true); Keyboard(0x0D, false); }
    }
    public void Dispose()
    {
        // Only release keys on the same locked desktop. A desktop switch must
        // not deliver any queued input to an ordinary application.
        if (DesktopHost.OnLockedDesktop(session))
        {
            foreach (var key in _held.ToArray()) { try { Keyboard(key, false); } catch { } }
            foreach (var button in _buttons.ToArray()) { try { Button(button, false); } catch { } }
        }
        _held.Clear(); _buttons.Clear();
    }
}
