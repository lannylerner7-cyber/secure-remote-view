using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace ConnectLive.Agent {
    internal static class LocalAccessState { internal static bool IsDisabled() => false; }
    internal static class Log { internal static void Warn(string value) {} internal static void Info(string value) {} }
    internal static class InputRelay { internal static void ReleaseHeldInputs() {} }
    internal static class StartupConsent { internal static void Clear() {} }
    internal static class GrantStore { internal static LocalGrant? Load() => null; }
    internal static class AgentProcessState { internal static string Instance => Guid.Empty.ToString(); }
    internal static class AgentHttpDiagnostics { internal static string SafeFailure(Exception ex, bool cancelled) => "test"; }
    internal static class UnlockOperation { internal static bool Sensitive => false; }
    internal static class CurtainController { internal static bool ActiveFor(PeerInputPermission owner) => false; }
    internal static class InputBlocker { internal static event Action? LocalMicrophoneStopRequested; }
    public sealed partial class ApiClient {
        internal string? DeviceId { get; set; } = Guid.NewGuid().ToString();
        internal string ApiBaseUrl => "https://example.invalid";
        internal LocalGrant? LocalAuthorization { get; set; }
        internal Task<bool> HasUsablePairingAsync(CancellationToken ct) => Task.FromResult(false);
        internal Task<JsonDocument> UnlockRequestAsync(object value, CancellationToken ct) =>
            Task.FromResult(JsonDocument.Parse("{}"));
        internal Task<HttpResponseMessage> SendAuthedAsync(Func<HttpRequestMessage> request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable));
        public Task<bool> UploadSessionFileChunkAsync(string session, string id, int seq, bool eof, string name, string mime,
            string sha, long size, byte[] bytes, CancellationToken ct, string? controller = null, string? peer = null) => Task.FromResult(false);
    }
    public sealed partial class WebRtcSession {
        public static WebRtcSession? Current { get; set; }
        private ApiClient _api = new();
        private string _sessionId = Guid.NewGuid().ToString();
        private bool _closed;
        private RTCPeerConnection? _pc;
        private PeerInputPermission? _peerPermission;
        private PeerInputPermission _inputPermission = null!;
        private PeerSignalBinding _signalBinding = new(() => true);
        private void ReportPermissionState() {}
    }
}
namespace Windows.Devices.Enumeration {
    public enum DeviceClass { AudioCapture }
    public enum DeviceAccessStatus { Unspecified,Allowed,DeniedBySystem,DeniedByUser }
    public sealed class DeviceAccessInformation {
        public DeviceAccessStatus CurrentStatus => DeviceAccessStatus.Unspecified;
        public static DeviceAccessInformation CreateFromDeviceClass(DeviceClass _) => new();
    }
}
namespace ConnectLive.Unlock {
    internal static class WindowsSession { internal static int CurrentId => 1; internal static bool? Locked(int id) => false; }
    internal static class UnlockPipe {
        internal static string BrokerName => "portable-test-no-helper";
        internal static string ProtectedPath(string name) => "/not-a-windows-install/" + name;
        internal static Task<System.IO.Pipes.NamedPipeClientStream> ConnectAsync(string name, CancellationToken ct) => throw new NotSupportedException();
        internal static Task WriteAsync(System.IO.Stream stream, object value, CancellationToken ct) => throw new NotSupportedException();
        internal static Task<JsonDocument> ReadAsync(System.IO.Stream stream, CancellationToken ct) => throw new NotSupportedException();
    }
}
namespace System.Windows {
    public enum MessageBoxButton { OK, YesNo }
    public enum MessageBoxImage { Information, Warning }
    public enum MessageBoxResult { OK, Yes, No }
    public static class MessageBox {
        public static MessageBoxResult Show(string message, string title = "", MessageBoxButton button = MessageBoxButton.OK,
            MessageBoxImage image = MessageBoxImage.Information) => MessageBoxResult.No;
    }
}
