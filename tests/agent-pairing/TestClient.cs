// Storage/UI stand-ins only; the send method, identity publication, diagnostic
// observer and permission guard are linked unchanged from production sources.
// No DPAPI, filesystem credentials, native code, Windows project or network.
using System.Net;
using System.Text;
using ConnectLive.Agent;

namespace ConnectLive.Agent
{
    public sealed partial class ApiClient
    {
        private readonly HttpClient _http;
        private readonly AgentHttpDiagnostics _httpDiagnostics;
        public string? DeviceId { get; private set; }
        public string? DeviceToken { get; private set; }
        internal LocalGrant? LocalAuthorization { get; set; }
        internal PeerInputPermission? LivePermission { get; set; }
        internal event Action? LiveAuthorityRejected;
        internal int AuthorityRejections;
        internal int IdentityRejections;
        internal int BuiltRequests;
        internal List<TrackedContent> BuiltContent = new();

        internal ApiClient(HttpClient http, TimeProvider clock, List<string> logs)
        {
            _http = http;
            _identityTime = clock;
            _httpDiagnostics = new((line, _) => logs.Add(line));
            LiveAuthorityRejected += () => AuthorityRejections++;
            OnEnrollmentRevoked += message => { IdentityRejections++; logs.Add(message); };
            ExplicitPairing("PRIVATE_DEVICE_A", "PRIVATE_TOKEN_A");
        }

        internal void ExplicitPairing(string deviceId, string token)
        {
            var scopes = new GrantScopes(true, true, true, true, false);
            var local = new LocalGrant("https://fixture.invalid", deviceId,
                new AuthorizationGrant(Guid.NewGuid().ToString(), "unattended", scopes, "2026-01-01T00:00:00Z"));
            SetPairedIdentity(deviceId, token, local);
            LivePermission = new PeerInputPermission("control", scopes, () => LocalAuthorization == local);
        }

        internal void ForgetInMemoryFixtureIdentity() { DeviceId = DeviceToken = null; }

        internal Task<HttpResponseMessage> SendTestAsync(string path = "/api/public/agent/hello",
            CancellationToken ct = default, AgentHttpOperation? operation = null) =>
            SendAuthedAsync(() =>
            {
                BuiltRequests++;
                var content = new TrackedContent();
                BuiltContent.Add(content);
                return new HttpRequestMessage(HttpMethod.Post, path) { Content = content };
            }, ct, operation);
    }
}

internal sealed class TrackedContent() : ByteArrayContent(Encoding.UTF8.GetBytes("PRIVATE_PAYLOAD"))
{
    internal bool Disposed;
    protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
}

internal sealed class FakeTime : TimeProvider
{
    private DateTimeOffset _now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => _now;
    internal void Advance() => _now += TimeSpan.FromSeconds(61);
}

internal sealed class FakeHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => send(request, ct);
}

internal sealed class Fixture : IDisposable
{
    internal readonly FakeTime Clock = new();
    internal readonly List<string> Logs = new();
    internal readonly List<(string Id, string Token, string Path)> Sent = new();
    internal Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Respond =
        (_, _) => Task.FromResult(Reply(HttpStatusCode.OK));
    internal readonly ApiClient Api;
    private readonly HttpClient _http;

    internal Fixture()
    {
        _http = new HttpClient(new FakeHandler((request, ct) =>
        {
            lock (Sent)
                Sent.Add((request.Headers.GetValues("X-Device-Id").Single(),
                    request.Headers.GetValues("X-Device-Token").Single(), request.RequestUri!.AbsolutePath));
            return Respond(request, ct);
        })) { BaseAddress = new Uri("https://fixture.invalid"), Timeout = TimeSpan.FromSeconds(20) };
        Api = new ApiClient(_http, Clock, Logs);
    }

    internal static HttpResponseMessage Reply(HttpStatusCode status) =>
        new(status) { Content = new StringContent("PRIVATE_RESPONSE_BODY") };
    public void Dispose() => _http.Dispose();
}
