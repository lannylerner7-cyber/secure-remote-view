using ConnectLive.Agent;
using System.Text.Json;

var assertions = 0;
void Check(bool result, string label)
{
    assertions++;
    if (!result) throw new Exception(label);
}
const string wire = """
{"id":"78a25847-38ee-47f9-8971-d286063ca3f2","noticeVersion":1,"mode":"unattended","capabilities":{"view":true,"control":false,"clipboard":true,"files":false,"recording":false},"recordedAt":"2026-01-01T12:00:00Z","revokedAt":null}
""";
AuthorizationGrant? Parse(string json)
{
    using var doc = JsonDocument.Parse(json);
    return AuthorizationGrant.Parse(doc.RootElement);
}
var grant = Parse(wire)!;
Check(grant != null, "valid grant parses");
foreach (var malformed in new[]
{
    "null", "{}", wire.Replace("\"noticeVersion\":1", "\"noticeVersion\":2"),
    wire.Replace("\"revokedAt\":null", "\"revokedAt\":\"2026-01-02T00:00:00Z\""),
    wire.Replace("\"mode\":\"unattended\"", "\"mode\":\"legacy\""),
    wire.Replace("\"control\":false", "\"control\":null"),
    wire.Replace("\"control\":false,", ""),
    wire.Replace("\"files\":false", "\"files\":false,\"extra\":true"),
    wire.Replace("\"files\":false", "\"files\":false,\"files\":true"),
    wire.Replace("\"view\":true", "\"view\":false").Replace("\"control\":false", "\"control\":true"),
    wire.Replace("2026-01-01T12:00:00Z", "yesterday"),
    wire.Replace("2026-01-01T12:00:00Z", "01/01/2026"),
    wire.Replace("78a25847-38ee-47f9-8971-d286063ca3f2", "legacy-id"),
})
    Check(Parse(malformed) == null, "reject malformed/legacy authority");
var local = new LocalGrant("https://example.test", "device-one", grant!);
Check(local.Matches("https://example.test/path", "device-one", grant), "origin binding");
Check(!local.Matches("http://example.test", "device-one", grant), "scheme binding");
Check(!local.Matches("https://example.test:444", "device-one", grant), "port binding");
Check(!local.Matches("https://attacker.test", "device-one", grant), "host binding");
Check(!local.Matches("https://example.test", "device-two", grant), "device binding");
Check(!local.Matches("https://example.test", "device-one", null), "missing authority");
Check(!local.Matches("https://example.test", "device-one", grant! with { Id = Guid.NewGuid().ToString() }), "grant replacement");
Check(!local.Matches("https://example.test", "device-one", grant! with { Mode = "attended" }), "mode mismatch");
Check(!local.Matches("https://example.test", "device-one", grant! with { Capabilities = grant.Capabilities with { Files = true } }), "scope broadening");
Check(!local.Matches("https://example.test", "device-one", grant! with { Capabilities = grant.Capabilities with { Clipboard = false } }), "scope narrowing requires new matching local grant");
foreach (var scope in new[] { "view", "control", "clipboard", "files", "recording" })
{
    var independent = new GrantScopes(scope == "view", false, scope == "clipboard", scope == "files", false);
    Check(independent.Allows(scope) == (scope is "view" or "clipboard" or "files"), "independent scopes");
}
Check(!grant!.Capabilities.Allows("unknown"), "unknown scope denied");
Check(!new PeerInputPermission("control").TryApply(() => throw new Exception()), "no implicit grant");
Check(!new PeerInputPermission("control", new(false, true, false, false, false), () => true)
    .TryApply(() => throw new Exception()), "native guard enforces control requires view");
bool valid = true;
var scopes = new GrantScopes(true, true, true, true, true);
var permission = new PeerInputPermission("control", scopes, () => valid);
Check(permission.Allows("files") && permission.TryApply(() => { }), "granted scope");
permission.SetMode("view");
Check(!permission.TryApply(() => throw new Exception()) && permission.Allows("view"), "view mode denies input");
valid = false;
Check(!permission.Allows("view") && !permission.Allows("files"), "authority loss denies every channel");
valid = true;
permission.Revoke(); // pause/end/revocation close this epoch forever.
permission.SetMode("control");
Check(permission.Token.IsCancellationRequested, "cancels pending IO");
foreach (var scope in new[] { "view", "control", "clipboard", "files", "recording" })
    Check(!permission.Allows(scope), "closed session cannot regain scopes");
Check(!permission.TryApply(() => throw new Exception()), "stale callback denied");
var next = new PeerInputPermission("control", scopes, () => true);
Check(next.Allows("control") && !permission.Allows("control"), "new epoch never revives old epoch");
using var registration = next.Token.Register(() =>
{
    Check(Task.Run(() => !next.Allows("control")).Wait(TimeSpan.FromSeconds(2)), "no permission lock across cancellation callbacks");
});
next.Revoke();
var directory = Path.Combine(Path.GetTempPath(), "agent-grants-" + Guid.NewGuid());
var marker = Path.Combine(directory, "access-disabled");
try
{
    Check(!LocalAccessState.IsDisabledAt(marker), "no withdrawal marker");
    LocalAccessState.DisableAt(marker);
    Check(LocalAccessState.IsDisabledAt(marker), "withdrawal survives restart");
}
finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }

// Offline startup must remain asynchronously pending, then continue exactly
// once after enrollment recovers. The helper has no grant/UI callback to invoke.
int attempts = 0, notices = 0, continuations = 0;
var retryEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var networkReturned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var recovery = EnrollmentRetry.RunAsync(
    _ =>
    {
        attempts++;
        return attempts == 1
            ? Task.FromException(new System.Net.Http.HttpRequestException("offline"))
            : Task.CompletedTask;
    },
    () => true,
    _ => notices++,
    CancellationToken.None,
    token =>
    {
        retryEntered.TrySetResult();
        return networkReturned.Task.WaitAsync(token);
    });
await retryEntered.Task;
Check(!recovery.IsCompleted && attempts == 1 && notices == 1, "offline startup yields instead of blocking or exiting");
networkReturned.SetResult();
if (await recovery) continuations++;
Check(attempts == 2 && continuations == 1, "online recovery continues startup once");

using (var stop = new CancellationTokenSource())
{
    int stoppedAttempts = 0;
    var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var canceledRecovery = EnrollmentRetry.RunAsync(
        _ => { stoppedAttempts++; return Task.FromException(new System.Net.Http.HttpRequestException("offline")); },
        () => true, _ => { }, stop.Token,
        token => { waiting.TrySetResult(); return Task.Delay(Timeout.Infinite, token); });
    await waiting.Task;
    stop.Cancel();
    bool canceled = false;
    try { await canceledRecovery; }
    catch (OperationCanceledException) { canceled = true; }
    Check(canceled && stoppedAttempts == 1, "local shutdown cancels pending delay without reenrollment");
}

bool locallyAllowed = true;
int withdrawnAttempts = 0;
var withdrawn = await EnrollmentRetry.RunAsync(
    _ => { withdrawnAttempts++; return Task.FromException(new System.Net.Http.HttpRequestException("offline")); },
    () => locallyAllowed, _ => { }, CancellationToken.None,
    _ => { locallyAllowed = false; return Task.CompletedTask; });
Check(!withdrawn && withdrawnAttempts == 1, "local withdrawal during retry prevents recovery");
bool allowedOnSuccess = true;
Check(!await EnrollmentRetry.RunAsync(
    _ => { allowedOnSuccess = false; return Task.CompletedTask; },
    () => allowedOnSuccess,
    _ => { }, CancellationToken.None), "withdrawal during success prevents startup continuation");

foreach (var rejection in new Exception[]
{
    new System.Net.Http.HttpRequestException("revoked", null, System.Net.HttpStatusCode.Forbidden),
    new System.Net.Http.HttpRequestException("unauthorized", null, System.Net.HttpStatusCode.Unauthorized),
    new OperationCanceledException("Meeting ID dismissed")
})
{
    int waits = 0;
    bool rejected = false;
    try
    {
        await EnrollmentRetry.RunAsync(_ => Task.FromException(rejection), () => true, _ => { },
            CancellationToken.None, _ => { waits++; return Task.CompletedTask; });
    }
    catch (Exception ex) when (ReferenceEquals(ex, rejection)) { rejected = true; }
    Check(rejected && waits == 0, "identity rejection or prompt dismissal never auto-retries");
}
Console.WriteLine($"PASS: {assertions} portable authorization assertions (no Windows runtime/native verification).");
