using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Input;

/// <summary>
/// Sends key + text events over session_inputs. Agent-side InputRelay maps
/// VK / modifier combos to SendInput. Text goes through Unicode injection so
/// non-ASCII characters and clipboard-style pastes work.
/// </summary>
public sealed class KeyboardInjector
{
    private readonly string _sessionId;
    public KeyboardInjector(string sessionId) => _sessionId = sessionId;

    public Task KeyAsync(string code, bool down, bool ctrl = false, bool shift = false, bool alt = false,
        CancellationToken ct = default)
        => App.Api.PushInputAsync(_sessionId, down ? "keydown" : "keyup",
            new { code, ctrl, shift, alt }, ct);

    public Task TextAsync(string text, CancellationToken ct = default)
        => App.Api.PushInputAsync(_sessionId, "text", new { text }, ct);
}
