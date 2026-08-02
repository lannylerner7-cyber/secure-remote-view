using System.Threading;
using System.Threading.Tasks;
using System.Windows.Input;

namespace ConnectLive.Admin.Input;

/// <summary>
/// Sends key + text events over session_inputs.
///
/// Payload shapes MUST match agent/src/InputRelay.cs:
///   keydown / keyup  { vk }   — Win32 virtual-key code (int)
///   text             { text } — Unicode injection (SendInput KEYEVENTF_UNICODE)
///
/// The previous { code, ctrl, shift, alt } shape was read by the agent as
/// GetInt(p, "vk") → 0, so no keystroke ever landed. Modifiers are sent as
/// their own vk down/up events by LiveSessionWindow, exactly like a physical
/// keyboard, so Ctrl/Alt/Shift combos work.
/// </summary>
public sealed class KeyboardInjector
{
    private readonly string _sessionId;
    public KeyboardInjector(string sessionId) => _sessionId = sessionId;

    public Task KeyAsync(int vk, bool down, CancellationToken ct = default)
        => vk <= 0
            ? Task.CompletedTask
            : App.Api.PushInputAsync(_sessionId, down ? "keydown" : "keyup", new { vk }, ct);

    /// <summary>WPF Key → Win32 virtual-key code.</summary>
    public Task KeyAsync(Key key, bool down, CancellationToken ct = default)
        => KeyAsync(KeyInterop.VirtualKeyFromKey(key), down, ct);

    public Task TextAsync(string text, CancellationToken ct = default)
        => App.Api.PushInputAsync(_sessionId, "text", new { text }, ct);
}
