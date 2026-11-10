using System.Text.Json;
using ConnectLive.Agent;

// Compile the ACTUAL action partial, not a transcription or source-string check.
// Windows and WebRTC adapters below are inert. This is not a Windows app build.
var session = new WebRtcSession();
var permissionId = Guid.NewGuid().ToString();
var permission = session.Dispatch("permission_refresh", new {
    request_id = permissionId, mode = "control", authorization_id = session.GrantId,
});
Check(permission.Single().GetProperty("request_id").GetString() == permissionId &&
      permission.Single().GetProperty("status").GetString() == "applied" &&
      permission.Single().GetProperty("mode").GetString() == "control",
    "permission refresh dispatch retains its correlated receipt");
var monitorId = Guid.NewGuid().ToString();
var monitor = session.Dispatch("switch_monitor", new {
    request_id = monitorId, device_name = "DISPLAY-TEST",
});
Check(monitor.Single().GetProperty("request_id").GetString() == monitorId &&
      monitor.Single().GetProperty("status").GetString() == "applied" &&
      session.KeyFrameRequests == 1,
    "monitor dispatch keeps its separate request variable and keyframe request");
Check(session.Dispatch("permission_refresh", new {
    request_id = "not-a-guid", mode = "control", authorization_id = session.GrantId,
}).Count == 0, "malformed permission request is ignored");
var curtainId = Guid.NewGuid().ToString();
var curtain = session.Dispatch("curtain_on", new { request_id = curtainId });
Check(curtain.Any(m => m.GetProperty("kind").GetString() == "action_status" &&
    m.GetProperty("request_id").GetString() == curtainId &&
    m.GetProperty("active").GetBoolean()), "curtain dispatch still reports the adapter application result");
Console.WriteLine("Actual Agent action partial compiled; routing checks passed with inert Windows/WebRTC adapters. NOT a Windows runtime test.");

static void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL " + name);
    Console.WriteLine("PASS " + name);
}

namespace ConnectLive.Agent
{
    public sealed partial class WebRtcSession
    {
        private readonly bool _closed = false;
        private readonly FakeApi _api = new();
        private readonly PeerInputPermission _inputPermission = new();
        private readonly PeerInputPermission _peerPermission;
        private readonly string _sessionId = Guid.NewGuid().ToString();
        private readonly string _currentAdminClientId = "web-test-controller";
        public int KeyFrameRequests { get; private set; }
        public string GrantId => _api.LocalAuthorization.Authorization.Id;
        public WebRtcSession()
        {
            _peerPermission = _inputPermission;
            _browserInput = new SIPSorcery.Net.RTCDataChannel();
        }
        public List<JsonElement> Dispatch(string kind, object payload)
        {
            _browserInput!.Sent.Clear();
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { kind, payload }));
            HandleBrowserAction(document.RootElement, _browserInput, _peerPermission);
            return _browserInput.Sent.Select(text => {
                using var message = JsonDocument.Parse(text);
                return message.RootElement.Clone();
            }).ToList();
        }
        private bool HandleUnlockAction(JsonElement root, SIPSorcery.Net.RTCDataChannel channel,
            PeerInputPermission owner, string kind) => false;
        private void RequestKeyFrame(string reason) => KeyFrameRequests++;
    }
    internal sealed class FakeApi
    {
        public FakeLocalGrant LocalAuthorization { get; } = new();
        public Task<bool> ConfirmSessionModeAsync(string session, string mode, string controller, CancellationToken token)
            => Task.FromResult(true);
    }
    internal sealed class FakeLocalGrant { public FakeGrant Authorization { get; } = new(); }
    internal sealed class FakeGrant { public string Id { get; } = Guid.NewGuid().ToString(); }
    internal sealed class PeerInputPermission
    {
        private string _mode = "view";
        private bool _revoked;
        public CancellationToken Token => CancellationToken.None;
        public bool Allows(string scope) => !_revoked && (scope == "view" || scope == "control" && _mode == "control");
        public bool SetMode(string mode, long observed = 0) { _mode = mode; return true; }
        public void Revoke() => _revoked = true;
        public bool TryApplyCapability(string scope, Action action)
        { if (!Allows(scope)) return false; action(); return true; }
    }
    internal static class CurtainController
    {
        private static bool _active;
        public static bool Supported => true;
        public static bool ActiveFor(PeerInputPermission owner) => _active;
        public static void Release(PeerInputPermission owner, string reason, Action<bool>? receipt = null)
        { _active = false; receipt?.Invoke(true); }
        public static bool Renew(PeerInputPermission owner) => _active;
        public static void Enable(PeerInputPermission owner, Action<bool> receipt, Action<bool, string> changed)
        { _active = owner.Allows("control"); receipt(_active); changed(_active, "test_adapter"); }
    }
    internal static class InputRelay { public static void ReleaseHeldInputs() { } }
    internal static class InputBlocker { public static void Release(string reason) { } }
    internal static class CurtainOverlay { public static void Hide() { } }
    internal static class Log { public static void Warn(string message) { } public static void Info(string message) { } }
    internal sealed record MonitorOutput(string DeviceName);
    internal static class MonitorSelector
    {
        public static string? SelectedDeviceName { get; private set; }
        public static MonitorOutput[] Outputs() => new[] { new MonitorOutput("DISPLAY-TEST") };
        public static void Select(string name) => SelectedDeviceName = name;
    }
}
namespace SIPSorcery.Net
{
    internal enum RTCDataChannelState { open, closed }
    internal sealed class RTCDataChannel
    {
        public RTCDataChannelState readyState = RTCDataChannelState.open;
        public event Action? onopen;
        public event Action? onclose;
        public List<string> Sent { get; } = new();
        public void send(string text) => Sent.Add(text);
        public void Open() => onopen?.Invoke();
        public void Close() { readyState = RTCDataChannelState.closed; onclose?.Invoke(); }
    }
}
namespace System.Windows
{
    internal sealed class Application
    {
        public static Application? Current => null;
        public FakeDispatcher Dispatcher { get; } = new();
    }
    internal sealed class FakeDispatcher { public void BeginInvoke(Action action) { } }
}
