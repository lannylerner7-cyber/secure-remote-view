// Portable authenticated-transport harness; never builds or runs the Windows Agent.
using System.Net;
using ConnectLive.Agent;

int checks = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new Exception(description);
    checks++;
}
async Task<T> Throws<T>(Func<Task> work) where T : Exception
{
    try { await work(); }
    catch (T exception) { checks++; return exception; }
    throw new Exception("Expected failure was swallowed");
}
void PairingUnchanged(Fixture f, LocalGrant? grant)
{
    Check(f.Api.DeviceId == "PRIVATE_DEVICE_A" && f.Api.DeviceToken == "PRIVATE_TOKEN_A", "paired identity retained");
    Check(ReferenceEquals(f.Api.LocalAuthorization, grant), "recorded local grant retained");
    Check(f.Sent.All(request => request.Id == "PRIVATE_DEVICE_A" && request.Token == "PRIVATE_TOKEN_A"), "same identity on every attempt");
    Check(f.Api.BuiltRequests == f.Sent.Count, "no hidden request replay or enrollment request");
    Check(f.Api.BuiltContent.All(content => content.Disposed), "request content always disposed");
    Check(f.Logs.All(line => !line.Contains("PRIVATE")), "diagnostics redact credentials, bodies and identities");
}

// Ordinary and sensitive paths all use the same non-replaying send path.
foreach (var path in new[] {
    "/api/public/agent/hello", "/api/public/agent/heartbeat", "/api/public/agent/release",
    "/api/public/agent/authorization", "/api/public/agent/authorization/revoke",
    "/api/public/agent/session/fixture/consent", "/api/public/agent/session/fixture/reconnect",
    "/api/public/agent/session/fixture/frame", "/api/public/agent/session/fixture/file",
    "/api/public/agent/session/fixture/signal", "/api/public/agent/ice?sessionId=fixture",
    "/api/public/agent/power/fixture/ack",
})
{
    using var f = new Fixture();
    var grant = f.Api.LocalAuthorization;
    using (var response = await f.Api.SendTestAsync(path)) Check(response.IsSuccessStatusCode, "authorized request succeeds");
    foreach (var status in new[] { HttpStatusCode.ServiceUnavailable, HttpStatusCode.InternalServerError,
        HttpStatusCode.BadGateway, HttpStatusCode.GatewayTimeout, HttpStatusCode.TooManyRequests })
    {
        f.Respond = (_, _) => Task.FromResult(Fixture.Reply(status));
        var before = f.Sent.Count;
        using var response = await f.Api.SendTestAsync(path, operation: AgentHttpOperation.Heartbeat);
        Check(response.StatusCode == status, "unavailable responses are explicit failures, not fabricated success");
        Check(f.Sent.Count == before + 1, "one attempt only on transient failure");
        Check(f.Api.IdentityRejections == 0, "dependency failure is not identity revocation");
        PairingUnchanged(f, grant);
    }
    // Recovery is a caller's new operation, not replay of the uncertain request.
    f.Respond = (_, _) => Task.FromResult(Fixture.Reply(HttpStatusCode.OK));
    using (var response = await f.Api.SendTestAsync(path)) Check(response.IsSuccessStatusCode, "same pairing recovers without re-enrollment");
    PairingUnchanged(f, grant);
}

foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden })
{
    using var f = new Fixture();
    var grant = f.Api.LocalAuthorization;
    var permission = f.Api.LivePermission!;
    var child = permission.Fork();
    Check(permission.Allows("view") && child.Allows("control"), "fixture begins with scoped live authority");
    f.Respond = (_, _) => Task.FromResult(Fixture.Reply(status));
    using (var response = await f.Api.SendTestAsync(operation: AgentHttpOperation.Frame))
        Check(response.StatusCode == status, "actual credential/permission rejection is preserved");
    Check(f.Sent.Count == 1, "a rejection is not retried");
    Check(f.Api.AuthorityRejections == 1, "coordinator is told to close authority");
    Check(permission.Token.IsCancellationRequested && child.Token.IsCancellationRequested, "parent and child lifetimes cancelled");
    Check(!permission.Allows("view") && !child.Allows("control"), "rejection fails closed for old callbacks");
    if (status == HttpStatusCode.Unauthorized)
    {
        Check(f.Api.IdentityRejections == 1, "identity rejection is reported once");
        var exception = await Throws<HttpRequestException>(() => f.Api.SendTestAsync());
        Check(exception.StatusCode == HttpStatusCode.Unauthorized, "cooldown is an explicit rejection");
        Check(f.Sent.Count == 1 && f.Api.BuiltRequests == 1, "cooldown does not construct or send a sensitive body");
        Check(!exception.Message.Contains("PRIVATE"), "cooldown diagnostic is redacted");
        f.Clock.Advance();
    }
    else Check(f.Api.IdentityRejections == 0, "permission rejection is not invalid pairing");
    f.Respond = (_, _) => Task.FromResult(Fixture.Reply(HttpStatusCode.OK));
    using (var response = await f.Api.SendTestAsync()) Check(response.IsSuccessStatusCode, "fresh same-identity request may recover");
    Check(!permission.Allows("view") && !child.Allows("control"), "HTTP recovery does not resurrect revoked session permissions");
    PairingUnchanged(f, grant);
}

foreach (var exception in new Exception[] {
    new HttpRequestException(HttpRequestError.NameResolutionError, "PRIVATE_DNS_URL"),
    new HttpRequestException(HttpRequestError.SecureConnectionError, "PRIVATE_TLS_URL"),
    new HttpRequestException(HttpRequestError.ConnectionError, "PRIVATE_NETWORK_URL"),
    new TaskCanceledException("PRIVATE_TIMEOUT", new TimeoutException()),
    new OperationCanceledException("PRIVATE_CANCELLATION"),
})
{
    using var f = new Fixture();
    var grant = f.Api.LocalAuthorization;
    f.Respond = (_, _) => Task.FromException<HttpResponseMessage>(exception);
    await Throws<Exception>(() => f.Api.SendTestAsync(operation: AgentHttpOperation.Heartbeat));
    Check(f.Sent.Count == 1 && f.Api.IdentityRejections == 0, "transport failure neither retries nor rejects identity");
    PairingUnchanged(f, grant);
    f.Respond = (_, _) => Task.FromResult(Fixture.Reply(HttpStatusCode.OK));
    using var response = await f.Api.SendTestAsync(operation: AgentHttpOperation.Heartbeat);
    Check(response.IsSuccessStatusCode, "network recovery does not require new pairing");
    PairingUnchanged(f, grant);
}

using (var f = new Fixture())
using (var cancellation = new CancellationTokenSource())
{
    cancellation.Cancel();
    await Throws<OperationCanceledException>(() => f.Api.SendTestAsync(ct: cancellation.Token));
    Check(f.Sent.Count == 0 && f.Api.BuiltRequests == 0, "cancelled lifetime cannot build/send a request");
    f.Api.ForgetInMemoryFixtureIdentity();
    await Throws<HttpRequestException>(() => f.Api.SendTestAsync());
    Check(f.Sent.Count == 0 && f.Api.BuiltRequests == 0, "missing identity requires explicit pairing, never automatic enrollment");
}

using (var f = new Fixture())
{
    var grant = f.Api.LocalAuthorization;
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    f.Respond = async (_, _) => { await gate.Task; return Fixture.Reply(HttpStatusCode.Unauthorized); };
    var pending = Enumerable.Range(0, 16).Select(_ => f.Api.SendTestAsync()).ToArray();
    Check(f.Sent.Count == 16, "fixture overlaps authenticated requests");
    gate.SetResult();
    var responses = await Task.WhenAll(pending);
    Check(responses.All(response => response.StatusCode == HttpStatusCode.Unauthorized), "all concurrent denials remain denials");
    foreach (var response in responses) response.Dispose();
    Check(f.Api.IdentityRejections == 1, "concurrent 401s produce one diagnostic/cooldown");
    Check(f.Sent.Count == 16, "burst never enrolls or replays");
    PairingUnchanged(f, grant);
}

using (var f = new Fixture())
{
    var pendingResponse = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
    f.Respond = (_, _) => pendingResponse.Task;
    var pending = f.Api.SendTestAsync("/api/public/agent/session/old/file");
    f.Api.ExplicitPairing("PRIVATE_DEVICE_B", "PRIVATE_TOKEN_B");
    var permission = f.Api.LivePermission;
    pendingResponse.SetResult(Fixture.Reply(HttpStatusCode.Unauthorized));
    using (var response = await pending) Check(response.StatusCode == HttpStatusCode.Unauthorized, "old request still fails");
    Check(f.Api.DeviceId == "PRIVATE_DEVICE_B" && f.Api.DeviceToken == "PRIVATE_TOKEN_B", "late rejection cannot erase explicit new pairing");
    Check(f.Api.IdentityRejections == 0 && f.Api.AuthorityRejections == 0, "late rejection cannot invalidate a different identity");
    Check(ReferenceEquals(f.Api.LivePermission, permission) && permission!.Allows("view"), "new explicitly established authority unaffected");
    Check(f.Sent.Count == 1 && f.Sent[0].Id == "PRIVATE_DEVICE_A", "sensitive old body never replayed as new identity");
    f.Respond = (_, _) => Task.FromResult(Fixture.Reply(HttpStatusCode.OK));
    using var fresh = await f.Api.SendTestAsync();
    Check(fresh.IsSuccessStatusCode && f.Sent[^1].Id == "PRIVATE_DEVICE_B", "only a new operation uses explicitly paired identity");
}

Console.WriteLine($"PASS: {checks} isolated pairing/HTTP assertions (no Windows build, credential files, database or network)");
