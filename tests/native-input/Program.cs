using ConnectLive.Admin.Input;
using SIPSorcery.Net;
using System.Text.Json;

var old = new RTCDataChannel();
InputTransport.Attach("old", old, "old-peer");
old.Open();
var current = new RTCDataChannel();
InputTransport.Attach("new", current, "new-peer");
old.Open();
if (InputTransport.CurrentPath != "rest") throw new Exception("Old open affected replacement");
current.Open();
old.Close();
old.Error();
if (InputTransport.CurrentPath != "dc") throw new Exception("Old close/error affected replacement");
await InputTransport.SendAsync("new", "mousemove", new { x = 0.25, y = 0.75 }, CancellationToken.None);
using var payload = JsonDocument.Parse(current.Last!);
if (payload.RootElement.GetProperty("payload").GetProperty("x").GetDouble() != .25 ||
    payload.RootElement.GetProperty("kind").GetString() != "mousemove")
    throw new Exception("Agent-compatible payload missing");
var sent = current.Count;
using var stop = new CancellationTokenSource();
stop.Cancel();
try { await InputTransport.SendAsync("new", "keydown", new { vk = 65 }, stop.Token); throw new Exception("Cancellation ignored"); }
catch (OperationCanceledException) { }
if (current.Count != sent) throw new Exception("Sent cancelled input");
await InputTransport.SendAsync("other", "keydown", new { vk = 65 }, CancellationToken.None);
if (current.Count != sent || ConnectLive.Admin.App.Api.RestCount != 1)
    throw new Exception("Wrong session used active channel");
await InputTransport.SendAsync("new", "release_inputs", new { }, CancellationToken.None);
if (ConnectLive.Admin.App.Api.RestCount != 2) throw new Exception("Safety REST path lost");
int acknowledgements = 0;
InputTransport.CurtainAcknowledged += (_, _, _) => acknowledgements++;
byte[] Ack(long sentAt) => JsonSerializer.SerializeToUtf8Bytes(new {
    kind = "curtain_status", request_id = "test", sent_at = sentAt, applied = true
});
old.Message(Ack(Environment.TickCount64));
current.Message(Ack(Environment.TickCount64 - 10_000));
if (acknowledgements != 0) throw new Exception("Stale acknowledgement accepted");
current.Message(Ack(Environment.TickCount64));
if (acknowledgements != 1) throw new Exception("Fresh acknowledgement rejected");
Console.WriteLine("PASS: nested wire payload, stale callback isolation, cancellation, session and safety routing");

const string grantId = "11111111-1111-4111-8111-111111111111";
byte[] Permission(string? request = null, string mode = "view", string grant = grantId) =>
    JsonSerializer.SerializeToUtf8Bytes(new {
        kind = "permission_status", session_id = "new", authorization_id = grant,
        mode, permission_refresh_supported = true, request_id = request, status = "applied",
    });
current.Message(Permission());
var refresh = InputTransport.RefreshPermissionAsync("new", "control", CancellationToken.None);
using var permissionRequest = JsonDocument.Parse(current.Last!);
var refreshId = permissionRequest.RootElement.GetProperty("payload").GetProperty("request_id").GetString()!;
old.Message(Permission(refreshId, "control"));
current.Message(Permission("not-the-request", "control"));
if (refresh.IsCompleted) throw new Exception("Uncorrelated permission acknowledgement accepted");
current.Message(Permission(refreshId, "control"));
await refresh;
var curtainId = Guid.NewGuid().ToString("N");
var curtain = InputTransport.ApplyCurtainAsync("new", curtainId, true, CancellationToken.None);
byte[] Applied(bool active, string grant = grantId, string action = "curtain_on") =>
    JsonSerializer.SerializeToUtf8Bytes(new {
        kind = "action_status", session_id = "new", authorization_id = grant,
        request_id = curtainId, action, status = "applied", active,
    });
current.Message(Applied(true, "foreign"));
if (curtain.IsCompleted) throw new Exception("Foreign grant curtain acknowledgement accepted");
current.Message(Applied(true));
await curtain;
var released = InputTransport.ApplyCurtainAsync("new", curtainId, false, CancellationToken.None);
current.Message(Applied(false, grantId, "curtain_off"));
await released;
var interrupted = InputTransport.RefreshPermissionAsync("new", "control", CancellationToken.None);
current.Close();
try { await interrupted; throw new Exception("Disconnected permission request survived"); }
catch (InvalidOperationException) { }
var beforeRenew = ConnectLive.Admin.App.Api.RestCount;
try { await InputTransport.SendAsync("new", "curtain_renew", new { }, CancellationToken.None);
    throw new Exception("A renewal used a delayed fallback"); }
catch (InvalidOperationException) { }
if (ConnectLive.Admin.App.Api.RestCount != beforeRenew) throw new Exception("Renewal was queued over REST");
Console.WriteLine("PASS: fresh correlated permission, grant-bound curtain apply/release, disconnect cancellation and renew-only transport");

namespace SIPSorcery.Net {
    public class RTCDataChannel {
        public event Action? onopen, onclose;
        public event Action<string>? onerror;
        public event Action<object?, object?, byte[]>? onmessage;
        public byte[]? Last;
        public int Count;
        public void send(byte[] value) { Last = value; Count++; }
        public void send(string value) => send(System.Text.Encoding.UTF8.GetBytes(value));
        public void Open() => onopen?.Invoke();
        public void Close() => onclose?.Invoke();
        public void Error() => onerror?.Invoke("synthetic");
        public void Message(byte[] bytes) => onmessage?.Invoke(null, null, bytes);
    }
}
namespace ConnectLive.Admin {
    public static class App { public static ApiStub Api = new(); }
    public class ApiStub {
        public int RestCount;
        public Task PushInputAsync(string session, string kind, object payload, CancellationToken ct) {
            ct.ThrowIfCancellationRequested(); RestCount++; return Task.CompletedTask;
        }
    }
}
namespace ConnectLive.Admin.Diag {
    public static class Log { public static void Write(string _) { } }
}
// Only the ordinary input/permission transport is under test here. These
// inert stubs do not simulate or claim to verify Windows unlock behavior.
namespace ConnectLive.Admin.Input {
    public record WindowsUnlockState(string Phase);
    public sealed class WindowsUnlockChannel : IDisposable {
        public string SessionId { get; }
        public bool Active => false;
        public event Action<WindowsUnlockState>? Changed { add { } remove { } }
        public WindowsUnlockChannel(string sessionId, string peerId, SIPSorcery.Net.RTCDataChannel channel)
            { SessionId = sessionId; }
        public void AllowOrdinaryInput() { }
        public void Input(string kind, object payload) { }
        public void Dispose() { }
    }
}
