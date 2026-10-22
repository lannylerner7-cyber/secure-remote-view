using ConnectLive.Agent;

// Exercises the actual withdrawal implementation without Windows, networking,
// credentials, enrollment or the remote-access runtime.
var root = Path.Combine(Path.GetTempPath(), "connectlive-withdrawal-" + Guid.NewGuid());
var marker = Path.Combine(root, "state", "access-disabled");
var checks = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new Exception("FAIL: " + name);
    checks++;
    Console.WriteLine("PASS: " + name);
}
try
{
    var applied = 0;
    var scopes = new GrantScopes(true, true, false, false, false);
    var input = new PeerInputPermission("view", scopes, () => true);
    Check(!input.TryApply(() => applied++), "view mode rejects peer input");
    input.SetMode("unknown");
    Check(!input.TryApply(() => applied++), "unknown mode rejects peer input");
    input.SetMode("control");
    Check(input.TryApply(() => applied++) && applied == 1, "control mode permits one guarded input");
    input.SetMode("view");
    Check(!input.TryApply(() => applied++) && applied == 1, "downgrade stops input");
    input.Revoke();
    input.SetMode("control");
    Check(!input.TryApply(() => applied++) && applied == 1, "revoked permission cannot be reenabled");
    var replacement = new PeerInputPermission("control", scopes, () => true);
    Check(replacement.TryApply(() => applied++), "new permission is independent of old one");
    Check(!input.TryApply(() => applied++), "new session cannot revive stale callbacks");
    Check(!LocalAccessState.IsDisabledAt(marker), "no marker is not a withdrawal");
    LocalAccessState.DisableAt(marker);
    Check(LocalAccessState.IsDisabledAt(marker), "withdrawal persists");
    LocalAccessState.DisableAt(marker);
    Check(LocalAccessState.IsDisabledAt(marker), "repeated withdrawal is idempotent");
    File.WriteAllText(marker, "");
    Check(LocalAccessState.IsDisabledAt(marker), "empty marker still disables");
    File.WriteAllText(marker, "unexpected content");
    Check(LocalAccessState.IsDisabledAt(marker), "corrupt marker cannot restore access");
    File.Delete(marker);
    Directory.CreateDirectory(marker);
    Check(LocalAccessState.IsDisabledAt(marker), "unreadable marker fails closed");
    var threw = false;
    try { LocalAccessState.DisableAt(marker); }
    catch (IOException) { threw = true; }
    catch (UnauthorizedAccessException) { threw = true; }
    Check(threw, "write failure is reported rather than claiming persistence");
    Console.WriteLine($"{checks} local safeguard checks passed.");
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, true);
}
