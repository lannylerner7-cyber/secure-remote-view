using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Admin.Input;

/// <summary>
/// Pushes absolute (0..1) mouse coordinates and click/wheel events into the
/// session_inputs queue. The agent maps 0..1 → its virtual desktop pixel
/// coordinates via MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK so drops
/// never de-sync.
/// </summary>
public sealed class MouseInjector
{
    private readonly string _sessionId;
    public MouseInjector(string sessionId) => _sessionId = sessionId;

    public Task MoveAsync(double x, double y, CancellationToken ct = default)
        => App.Api.PushInputAsync(_sessionId, "mousemove_abs", new { x, y }, ct);

    public Task DownAsync(string button, double x, double y, CancellationToken ct = default)
        => App.Api.PushInputAsync(_sessionId, "mousedown", new { button, x, y }, ct);

    public Task UpAsync(string button, double x, double y, CancellationToken ct = default)
        => App.Api.PushInputAsync(_sessionId, "mouseup", new { button, x, y }, ct);

    public Task WheelAsync(int deltaX, int deltaY, CancellationToken ct = default)
        => App.Api.PushInputAsync(_sessionId, "wheel", new { deltaX, deltaY }, ct);
}
