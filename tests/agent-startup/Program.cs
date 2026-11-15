using ConnectLive.Agent;
using System.Xml.Linq;
using System.Text.Json;

int checks = 0;
void Check(bool ok, string label)
{
    if (!ok) throw new Exception(label);
    checks++;
}
var prefix = Path.Combine(Path.GetTempPath(), "connectlive-startup-fixture");
var custom = Path.Combine(prefix, "Custom Install & tools");
var normal = Path.Combine(prefix, "Program Files", "ConnectLive");
var exe = Path.Combine(custom, "ConnectLive.exe");
Check(StartupRegistration.FindMatchingInstallDirectory(exe, new[] { normal, custom }) == custom,
    "MSI custom path is matched even when another install location is listed first");
Check(StartupRegistration.FindMatchingInstallDirectory(exe, new[] { custom + Path.DirectorySeparatorChar }) == custom,
    "trailing directory separator is normalized");
Check(StartupRegistration.FindMatchingInstallDirectory(Path.Combine(custom + "-source", "ConnectLive.exe"), new[] { custom }) == null,
    "source sibling does not inherit installed startup rights");
Check(StartupRegistration.FindMatchingInstallDirectory(Path.Combine(custom, "dist", "ConnectLive.exe"), new[] { custom }) == null,
    "development subdirectory is not the installed Agent");
Check(StartupRegistration.FindMatchingInstallDirectory(Path.Combine(custom, "Other.exe"), new[] { custom }) == null,
    "different executable cannot register as the Agent");
Check(StartupRegistration.FindMatchingInstallDirectory("ConnectLive.exe", new[] { custom }) == null,
    "relative executable is rejected");
Check(StartupRegistration.FindMatchingInstallDirectory(exe, new[] { "", "relative", normal }) == null,
    "invalid/mismatched registry locations are ignored");
Check(!await StartupSetup.HandleAsync(new[] { "/background" }), "background launch cannot invoke startup approval UI");

XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
var sid = "S-1-5-21-1-2-3-1001";
var task = StartupTaskDefinition.Create(sid, Path.Combine(custom, "ConnectLiveWatch.exe"), custom,
    new DateTime(2026, 11, 15, 12, 0, 0));
string? Value(string name) => task.Descendants(ns + name).FirstOrDefault()?.Value;
Check(task.Elements(ns + "Triggers").Single().Elements().Count() == 2, "exactly logon and timed recovery triggers");
Check(task.Descendants(ns + "LogonTrigger").Single().Element(ns + "UserId")?.Value == sid, "logon limited to paired Windows user");
Check(!task.Descendants(ns + "BootTrigger").Any(), "no pre-login boot service");
Check(Value("Interval") == "PT1M", "bounded one-minute Watch retry");
Check(Value("LogonType") == "InteractiveToken" && Value("RunLevel") == "LeastPrivilege", "never SYSTEM or elevated task");
Check(Value("MultipleInstancesPolicy") == "IgnoreNew", "scheduler cannot spawn overlapping Watch copies");
Check(Value("ExecutionTimeLimit") == "PT0S", "Windows default three-day task limit is overridden");
Check(Value("Hidden") == "false" && Value("WakeToRun") == "false", "visible task without waking sleeping device");
Check(Value("DisallowStartIfOnBatteries") == "false" && Value("StopIfGoingOnBatteries") == "false", "laptops retain opted-in recovery on battery");
Check(Value("Command") == Path.Combine(custom, "ConnectLiveWatch.exe") && Value("WorkingDirectory") == custom,
    "only adjacent Watch is executed");
Check(XElement.Parse(task.ToString()).Descendants(ns + "Command").Single().Value == Path.Combine(custom, "ConnectLiveWatch.exe"),
    "spaces and XML metacharacters survive task serialization");
Check(!task.Descendants(ns + "Arguments").Any(), "no remote-supplied commands or hidden launch flags");

var grant = new LocalGrant("https://fixture.invalid", Guid.NewGuid().ToString(),
    new AuthorizationGrant(Guid.NewGuid().ToString(), "unattended",
        new GrantScopes(true, true, false, false, false), "2026-11-15T12:00:00Z"));
var generation = Guid.NewGuid().ToString("D");
Check(InstallationLifecycle.GrantIsCurrent(grant, () => null), "existing install retains pairing if never removed");
Check(!InstallationLifecycle.GrantIsCurrent(grant, () => generation), "offline user's old pairing is invalid after uninstall");
Check(InstallationLifecycle.GrantIsCurrent(grant with { InstallationGeneration = generation }, () => generation),
    "foreground re-pair can accept the new installation");
Check(!InstallationLifecycle.GrantIsCurrent(grant with { InstallationGeneration = generation }, () => Guid.NewGuid().ToString("D")),
    "a second uninstall invalidates a previously reauthorized installation");
Check(!InstallationLifecycle.GrantIsCurrent(grant with { InstallationGeneration = generation }, () => null),
    "missing removal history cannot silently restore a bound approval");
Check(!InstallationLifecycle.GrantIsCurrent(grant, () => throw new IOException("unreadable")), "unreadable machine receipt fails closed");
Check(InstallationLifecycle.RemovalKeyFor(custom) == InstallationLifecycle.RemovalKeyFor(custom + Path.DirectorySeparatorChar),
    "uninstall receipt uses canonical path");
Check(InstallationLifecycle.RemovalKeyFor(custom) != InstallationLifecycle.RemovalKeyFor(normal), "separate install directories have separate removal receipts");
Check(InstallationLifecycle.RemovalKeyFor(custom).Length == 64 && !InstallationLifecycle.RemovalKeyFor(custom).Contains("ConnectLive"),
    "history key does not expose the installation directory");
var roundTrip = JsonSerializer.Deserialize<LocalGrant>(JsonSerializer.Serialize(grant with { InstallationGeneration = generation }));
Check(roundTrip?.InstallationGeneration == generation && roundTrip.Matches(grant.Origin, grant.DeviceId, grant.Authorization),
    "local installation binding does not change the server authorization wire contract");
Console.WriteLine($"{checks} startup/removal policy checks passed; actual production startup sources compiled.");
Console.WriteLine("No Windows client was built. Registry, DPAPI, Task Scheduler, MSI execution and reboot are not runtime-tested here.");
