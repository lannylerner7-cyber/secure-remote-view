// Portable unit harness only. No Agent, WPF, native codec, Windows build or network.
using ConnectLive.Agent;
using System.Net;
using System.Net.Http;

int checks = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception(name);
    checks++;
}
async Task Send(AgentHttpDiagnostics diagnostics,
    Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond,
    AgentHttpOperation operation = AgentHttpOperation.Frame,
    CancellationToken requestToken = default, CancellationToken lifetimeToken = default)
{
    using var client = new HttpClient(new FakeHandler(respond));
    using var request = new HttpRequestMessage(HttpMethod.Post, "https://fixture.invalid/PRIVATE_URL?token=PRIVATE_QUERY");
    request.Headers.Add("X-Device-Token", "PRIVATE_TOKEN");
    request.Content = new StringContent("PRIVATE_FRAME");
    using var response = await diagnostics.SendAsync(client, request, operation, requestToken, lifetimeToken, 1);
}
Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Reply(HttpStatusCode status) =>
    (request, _) =>
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent("PRIVATE_RESPONSE") };
        response.Headers.Add("X-ConnectLive-Request-Id", request.Headers.GetValues("X-ConnectLive-Request-Id"));
        response.Headers.Add("X-ConnectLive-Server-Ms", "123");
        response.Headers.Add("X-ConnectLive-Stage", "frame_write");
        response.Headers.Add("X-ConnectLive-Slowest-Stage", "device_auth");
        response.Headers.Add("X-ConnectLive-Slowest-Ms", "120");
        response.Headers.Add("X-ConnectLive-Live-Protocol", "2");
        response.Headers.Add("X-ConnectLive-Outcome", status == HttpStatusCode.OK ? "ok" : "frame_write_failed");
        return Task.FromResult(response);
    };
async Task ExpectThrow(Func<Task> call)
{
    try { await call(); }
    catch { checks++; return; }
    throw new Exception("HTTP exception was swallowed");
}
var logs = new List<(string Text, bool Warning)>();
long now = 0;
var observer = new AgentHttpDiagnostics((line, warning) => logs.Add((line, warning)), () => now);
await Send(observer, Reply(HttpStatusCode.OK));
Check(logs[0].Text.Contains("status=200") && logs[0].Text.Contains("server_ms=123"), "success metadata");
Check(logs[0].Text.Contains("server_seen=true") && logs[0].Text.Contains("server_stage=frame_write"), "correlated headers");
Check(logs[0].Text.Contains("slowest_stage=device_auth") && logs[0].Text.Contains("slowest_ms=120") &&
    logs[0].Text.Contains("server_protocol=2"), "slowest stage and protocol, not just final stage");
Check(!logs[0].Warning, "healthy log is not a warning");
foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.Conflict,
    HttpStatusCode.RequestEntityTooLarge, HttpStatusCode.InternalServerError, HttpStatusCode.ServiceUnavailable })
{
    now += 60_000;
    await Send(observer, Reply(status));
    Check(logs[^1].Text.Contains($"status={(int)status}") && logs[^1].Warning, "numeric HTTP failures");
}
now += 60_000;
await Send(observer, Reply(HttpStatusCode.OK));
Check(logs[^1].Text.Contains("recovered_after=6"), "recovery count");
Check(logs.All(log => !log.Text.Contains("PRIVATE")), "no request/response/token content");

now += 60_000;
await Send(observer, (_, _) =>
{
    var response = new HttpResponseMessage(HttpStatusCode.BadGateway);
    response.Headers.Add("X-ConnectLive-Request-Id", "PRIVATE_TOKEN");
    response.Headers.Add("X-ConnectLive-Server-Ms", "PRIVATE_TOKEN");
    response.Headers.Add("X-ConnectLive-Stage", "PRIVATE_TOKEN");
    response.Headers.Add("X-ConnectLive-Outcome", "PRIVATE_TOKEN");
    response.Headers.Add("X-ConnectLive-Slowest-Stage", "PRIVATE_TOKEN");
    response.Headers.Add("X-ConnectLive-Slowest-Ms", "-999");
    response.Headers.Add("X-ConnectLive-Live-Protocol", "1001");
    return Task.FromResult(response);
});
Check(!logs[^1].Text.Contains("PRIVATE"), "diagnostic header allowlists");
Check(logs[^1].Text.Contains("server_seen=false") && logs[^1].Text.Contains("server_stage=none"), "invalid headers discarded");
Check(logs[^1].Text.Contains("slowest_stage=none") && logs[^1].Text.Contains("slowest_ms=none") &&
    logs[^1].Text.Contains("server_protocol=unreported"), "invalid slowest/protocol metadata discarded");

Check(AgentHttpDiagnostics.FailureCategory(new OperationCanceledException(), true, true) == "cancelled",
    "lifetime cancellation takes precedence over frame deadline");
Check(AgentHttpDiagnostics.FailureCategory(new OperationCanceledException(), false, true) == "deadline", "frame deadline");
Check(AgentHttpDiagnostics.FailureCategory(new TaskCanceledException("PRIVATE", new TimeoutException())) == "http_timeout",
    "HttpClient timeout");
Check(AgentHttpDiagnostics.FailureCategory(new OperationCanceledException()) == "cancelled_unknown",
    "do not guess an unknown cancellation is timeout");
foreach (var (error, label) in new[] {
    (HttpRequestError.NameResolutionError, "dns_error"), (HttpRequestError.ConnectionError, "connection_error"),
    (HttpRequestError.SecureConnectionError, "tls_error"), (HttpRequestError.HttpProtocolError, "protocol_error"),
    (HttpRequestError.ProxyTunnelError, "proxy_error"), (HttpRequestError.ResponseEnded, "response_ended"),
    (HttpRequestError.InvalidResponse, "invalid_response"), (HttpRequestError.Unknown, "transport_error"),
})
{
    now += 60_000;
    var exception = new HttpRequestException(error, "PRIVATE_EXCEPTION");
    Check(AgentHttpDiagnostics.FailureCategory(exception) == label, $"classification {label}");
    await ExpectThrow(() => Send(observer, (_, _) => Task.FromException<HttpResponseMessage>(exception)));
    Check(logs[^1].Text.Contains($"outcome={label}") && !logs[^1].Text.Contains("PRIVATE"), "exception redaction");
}
now += 60_000;
using (var deadline = new CancellationTokenSource())
{
    deadline.Cancel();
    await ExpectThrow(() => Send(observer, Reply(HttpStatusCode.OK), requestToken: deadline.Token));
    Check(logs[^1].Text.Contains("outcome=deadline") && logs[^1].Text.Contains("budget_ms=3000"), "real canceled send");
}
var cancellationLogs = new List<(string Text, bool Warning)>();
var cancellationObserver = new AgentHttpDiagnostics((line, warning) => cancellationLogs.Add((line, warning)));
using (var lifetime = new CancellationTokenSource())
{
    lifetime.Cancel();
    await ExpectThrow(() => Send(cancellationObserver, Reply(HttpStatusCode.OK),
        requestToken: lifetime.Token, lifetimeToken: lifetime.Token));
    Check(cancellationLogs[0].Text.Contains("outcome=cancelled") && !cancellationLogs[0].Warning,
        "normal teardown is not an upload failure");
}
now += 60_000;
await ExpectThrow(() => Send(observer, (_, _) =>
    Task.FromException<HttpResponseMessage>(new TaskCanceledException("PRIVATE", new TimeoutException())),
    AgentHttpOperation.Heartbeat));
Check(logs[^1].Text.Contains("outcome=http_timeout") && logs[^1].Text.Contains("budget_ms=20000"), "heartbeat timeout");
Check(!AgentHttpDiagnostics.SafeFailure(new Exception("PRIVATE")).Contains("PRIVATE"), "coordinator safe summary");

var bounded = new List<string>();
now = 0;
var rateLimited = new AgentHttpDiagnostics((line, _) => bounded.Add(line), () => now);
for (int i = 0; i < 100; i++)
{
    await Send(rateLimited, Reply(HttpStatusCode.ServiceUnavailable));
    await Send(rateLimited, Reply(HttpStatusCode.OK));
}
Check(bounded.Count <= 7, "flapping logs capped");
Check(bounded.All(line => line.Length < 1_000), "bounded line length");
await Send(rateLimited, Reply(HttpStatusCode.ServiceUnavailable), AgentHttpOperation.Heartbeat);
Check(bounded[^1].Contains("op=heartbeat"), "independent operation budgets");
now += 60_000;
await Send(rateLimited, Reply(HttpStatusCode.OK));
Check(bounded[^1].Contains("suppressed=194"), "suppressed attempts retained through recovery");
var brokenLogger = new AgentHttpDiagnostics((_, _) => throw new Exception("logger unavailable"));
await Send(brokenLogger, Reply(HttpStatusCode.OK));
await ExpectThrow(() => Send(brokenLogger, (_, _) => Task.FromException<HttpResponseMessage>(new HttpRequestException())));
Console.WriteLine($"PASS: {checks} isolated HTTP diagnostic assertions (no Windows Agent build or network)");

sealed class FakeHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        respond(request, cancellationToken);
}
