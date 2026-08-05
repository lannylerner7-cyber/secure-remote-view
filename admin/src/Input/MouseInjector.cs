using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Input;

/// <summary>
/// Pushes absolute (0..1) mouse coordinates and click/wheel events into the
/// session_inputs queue. The agent maps 0..1 → its virtual desktop pixel
/// coordinates via MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK so drops
/// never de-sync.
///
/// Payload shapes MUST match the switch in agent/src/InputRelay.cs:
///   mousemove  { x, y }        (0..1 normalised)
///   mousedown  { button }      (0 = left, 1 = middle, 2 = right)
///   mouseup    { button }
///   wheel      { dy }          (browser-style: positive = scroll down)
/// The old mousemove_abs / string button / deltaX-deltaY shapes were silently
/// dropped by the agent — every native-admin input was a no-op.
/// </summary>
public sealed class MouseInjector
{
    private readonly string _sessionId;
    public MouseInjector(string sessionId) => _sessionId = sessionId;

    public const int Left = 0;
    public const int Middle = 1;
    public const int Right = 2;

    public Task MoveAsync(double x, double y, CancellationToken ct = default)
        => InputTransport.SendAsync(_sessionId, "mousemove", new { x, y }, ct);

    // NOTE: there is no MoveRelAsync here. The agent still understands
    // "mousemove_rel" (agent/src/InputRelay.cs:88) and the browser console uses
    // it for pointer-lock, but the WPF console has no pointer-capture toggle, so
    // shipping an uncalled wrapper was dead weight. Re-add it here the same turn
    // the toggle lands — not before.



    public Task DownAsync(int button, double x, double y, CancellationToken ct = default)
        => PressAsync("mousedown", button, x, y, ct);

    public Task UpAsync(int button, double x, double y, CancellationToken ct = default)
        => PressAsync("mouseup", button, x, y, ct);

    // The agent's mousedown/mouseup handlers only read `button`; the pointer is
    // positioned by the preceding mousemove. We still send the coordinates so a
    // dropped move can't land the click at a stale position.
    private Task PressAsync(string kind, int button, double x, double y, CancellationToken ct)
        => InputTransport.SendAsync(_sessionId, kind, new { button, x, y }, ct);

    /// <summary>
    /// <paramref name="wpfDelta"/> is the raw WPF MouseWheelEventArgs.Delta
    /// (+120 = one notch up). The agent expects browser semantics and applies
    /// its own 3x multiplier, so we invert and scale down to one notch.
    /// </summary>
    public Task WheelAsync(int wpfDelta, CancellationToken ct = default)
        => InputTransport.SendAsync(_sessionId, "wheel", new { dy = -wpfDelta / 3 }, ct);
}
