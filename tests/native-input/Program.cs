using ConnectLive.Admin.Input;
using SIPSorcery.Net;
using System.Text.Json;

var old = new RTCDataChannel();
InputTransport.Attach("old", old);
old.Open();
var current = new RTCDataChannel();
InputTransport.Attach("new", current);
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

namespace SIPSorcery.Net {
    public class RTCDataChannel {
        public event Action? onopen, onclose;
        public event Action<string>? onerror;
        public event Action<object?, object?, byte[]>? onmessage;
        public byte[]? Last;
        public int Count;
        public void send(byte[] value) { Last = value; Count++; }
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
