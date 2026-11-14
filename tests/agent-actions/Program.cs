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
var mediaViewer = new WebRtcSession();
mediaViewer.Dispatch("video_keyframe", new { session_id = mediaViewer.SessionId, authorization_id = mediaViewer.GrantId });
Check(mediaViewer.KeyFrameRequests == 1 && mediaViewer.InputState.Paused,
    "view-only keyframe request uses the current grant without resuming input");
mediaViewer.Dispatch("video_keyframe", new { session_id = "other-session", authorization_id = mediaViewer.GrantId });
mediaViewer.Dispatch("video_keyframe", new { session_id = mediaViewer.SessionId, authorization_id = "other-grant" });
mediaViewer.Dispatch("video_keyframe", new { session_id = false, authorization_id = mediaViewer.GrantId });
Check(mediaViewer.KeyFrameRequests == 1, "foreign or malformed media requests cannot affect the encoder");
mediaViewer.RevokeViewing();
mediaViewer.Dispatch("video_keyframe", new { session_id = mediaViewer.SessionId, authorization_id = mediaViewer.GrantId });
Check(mediaViewer.KeyFrameRequests == 1, "withdrawal blocks even a correctly bound keyframe hint");
var curtainId = Guid.NewGuid().ToString();
CurtainController.Failure = CurtainApplyResult.Failed("capture_exclusion_failed", 87);
var rejectedCurtain = session.Dispatch("curtain_on", new { request_id = Guid.NewGuid().ToString() });
Check(rejectedCurtain.Single().GetProperty("reason").GetString() == "capture_exclusion_failed" &&
      rejectedCurtain.Single().GetProperty("native_error").GetInt32() == 87 &&
      rejectedCurtain.Single().GetProperty("status").GetString() == "rejected" &&
      !rejectedCurtain.Single().GetProperty("active").GetBoolean(),
    "capture-exclusion failure retains its specific reason and numeric Windows error");
CurtainController.Failure = null;
var curtain = session.Dispatch("curtain_on", new { request_id = curtainId });
Check(curtain.Any(m => m.GetProperty("kind").GetString() == "action_status" &&
    m.GetProperty("request_id").GetString() == curtainId &&
    m.GetProperty("active").GetBoolean()), "curtain dispatch still reports the adapter application result");
var firstInput = session.InputState;
Check(firstInput.Paused && !session.Apply(firstInput.Epoch), "receiving input starts blocked despite control mode");
var resumeInput = session.Dispatch("input_pause", session.InputRequest(false));
Check(resumeInput.Single().GetProperty("status").GetString() == "applied" &&
      !session.InputState.Paused && session.Apply(session.InputState.Epoch),
    "actual resume handler checks fresh permission and opens a new input generation");
var activeEpoch = session.InputState.Epoch;
var pauseInput = session.Dispatch("input_pause", session.InputRequest(true));
Check(pauseInput.Single().GetProperty("status").GetString() == "applied" &&
      session.InputState.Paused && session.ReleaseCalls > 0 && !session.Apply(activeEpoch),
    "actual pause handler drains/releases input before its receipt");
Check(CurtainController.ActiveFor(null!), "input pause does not clear the existing curtain");
Check(session.Dispatch("input_pause", session.InputRequest(false, foreignPeer: true)).Count == 0,
    "pause protocol rejects a foreign peer binding");
session.AllowResume = false;
Check(session.Dispatch("input_pause", session.InputRequest(false)).Single().GetProperty("status").GetString() == "rejected" &&
      session.InputState.Paused, "a rejected fresh server check cannot resume input");
session.AllowResume = true;
session.Dispatch("input_pause", session.InputRequest(false));
Check(!session.Apply(activeEpoch), "pre-pause input cannot be replayed after resume");
foreach (var field in new[] { "process_id", "peer_id", "controller_id", "input_revision" })
{
    var bad = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(session.InputRequest(true)))!.AsObject();
    bad[field] = true;
    Check(session.Dispatch("input_pause", bad).Count == 0, "wrong JSON type is rejected for " + field);
}
session.Dispatch("input_pause", session.InputRequest(true));
var delayed = session.DelayPermission();
Check(session.Dispatch("input_pause", session.InputRequest(false)).Count == 0,
    "resume waits for the fresh permission response");
session.CloseInput();
delayed.SetResult(true);
await Task.Delay(20);
Check(session.InputState.Paused, "actual input-channel close revokes and blocks the shared receiver");
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
        private readonly PeerInputPermission _inputPermission;
        private readonly PeerInputPermission _peerPermission;
        private readonly string _sessionId = Guid.NewGuid().ToString();
        private readonly string _currentAdminClientId = "web-test-controller";
        private readonly FakeBinding _signalBinding = new();
        private readonly FakeUnlock? _unlock = null;
        internal InputPauseSnapshot InputState => _inputPermission.InputState;
        internal bool AllowResume { set => _api.Allowed = value; }
        internal int ReleaseCalls { get; private set; }
        internal bool Apply(string epoch) => _peerPermission.TryApplyInput(epoch, () => { });
        internal void CloseInput() => _browserInput!.Close();
        internal TaskCompletionSource<bool> DelayPermission() =>
            _api.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal object InputRequest(bool paused, bool foreignPeer = false) => new {
            request_id = Guid.NewGuid().ToString("D"), paused, authorization_id = GrantId,
            peer_id = foreignPeer ? Guid.NewGuid().ToString("D") : _signalBinding.PeerId,
            process_id = AgentProcessState.Instance, controller_id = _currentAdminClientId,
            input_epoch = InputState.Epoch, input_revision = InputState.Revision,
        };
        public int KeyFrameRequests { get; private set; }
        public string GrantId => _api.LocalAuthorization.Authorization.Id;
        public string SessionId => _sessionId;
        internal void RevokeViewing() => _peerPermission.Revoke();
        public WebRtcSession()
        {
            _inputPermission = new("view", new(true, true, true, true, true), () => true,
                releaseInputs: () => { ReleaseCalls++; return true; });
            _peerPermission = _inputPermission.Fork();
            _browserInput = new SIPSorcery.Net.RTCDataChannel();
            AttachBrowserInputStatus(_browserInput, _peerPermission);
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
        public bool Allowed = true;
        public TaskCompletionSource<bool>? Pending;
        public FakeLocalGrant LocalAuthorization { get; } = new();
        public Task<bool> ConfirmSessionModeAsync(string session, string mode, string controller, CancellationToken token)
            => Pending?.Task ?? Task.FromResult(Allowed);
    }
    internal sealed class FakeLocalGrant { public FakeGrant Authorization { get; } = new(); }
    internal sealed class FakeGrant { public string Id { get; } = Guid.NewGuid().ToString(); }
    internal sealed class FakeBinding { public string PeerId { get; } = Guid.NewGuid().ToString("D"); }
    internal sealed class FakeUnlock { public bool Active => false; }
    internal static class AgentProcessState { public static readonly string Instance = Guid.NewGuid().ToString("D"); }
    internal static class CurtainController
    {
        private static bool _active;
        public static CurtainApplyResult? Failure;
        public static bool Supported => true;
        public static bool ActiveFor(PeerInputPermission owner) => _active;
        public static void Release(PeerInputPermission owner, string reason, Action<bool>? receipt = null)
        { _active = false; receipt?.Invoke(true); }
        public static bool Renew(PeerInputPermission owner) => _active;
        public static void EnableDetailed(PeerInputPermission owner, Action<CurtainApplyResult> receipt, Action<bool, string> changed)
        {
            if (Failure is { } failure) { _active = false; receipt(failure); return; }
            _active = owner.Allows("control");
            receipt(_active ? CurtainApplyResult.Success : CurtainApplyResult.Failed("authorization_changed"));
            changed(_active, "test_adapter");
        }
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
