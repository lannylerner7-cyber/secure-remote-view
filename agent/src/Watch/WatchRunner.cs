using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using ConnectLive.Agent;

namespace ConnectLive.Watch;

/// <summary>A visible, opted-in companion. It launches only the adjacent Agent,
/// never executes a supplied command, enrolls, elevates, or clears local withdrawal.</summary>
internal sealed class WatchRunner
{
    private readonly string _instance = Guid.NewGuid().ToString("D");
    private readonly string _grant = GrantStore.Load()!.Authorization.Id;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly RecoveryBudget _budget = new();
    private readonly HttpClient _http = new(new SocketsHttpHandler {
        AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(10)
    }) { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly JsonSerializerOptions Json = new() {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, PropertyNameCaseInsensitive = true
    };
    private long _sequence;
    private Command? _command;
    private string? _receipt;
    private string? _detail;
    private DateTimeOffset? _launchDeadline;
    private bool _launched;
    private bool _launchFailed;
    private DateTimeOffset _lastReport;
    private string? _lastState;

    private sealed record Command(string Id, string AuthorizationId, DateTimeOffset ExpiresAt, string State);
    private sealed record Reply(bool Authorized, Command? Command, string? Error);

    private bool Allowed() => StartupConsent.IsAllowed() && GrantStore.Load()?.Authorization.Id == _grant;
    private void Nudge() { try { _wake.Release(); } catch (SemaphoreFullException) { } }

    internal async Task<int> RunAsync()
    {
        using var stop = new CancellationTokenSource();
        var stream = ListenAsync(stop.Token);
        var failures = 0;
        try
        {
            while (Allowed() && !UpdateEnvironment.Pending())
            {
                try
                {
                    using var process = Program.FindAgent();
                    var snapshot = AgentProcessState.Read();
                    var healthy = process != null && AgentProcessState.IsHealthy(snapshot, process, _grant);
                    var now = DateTimeOffset.UtcNow;
                    if (_launchDeadline is { } deadline && now >= deadline && !healthy)
                    {
                        _launchFailed = true;
                        _launchDeadline = null;
                        _receipt = _command == null ? null : "failed";
                        _detail = "launch_health_timeout";
                    }
                    var state = process == null ? "stopped" : healthy ? "running" : "starting";
                    if (_launchFailed) state = "failed";
                    if (healthy)
                    {
                        _launchFailed = false;
                        _detail = null;
                        state = "running";
                        _launchDeadline = null;
                        if (_command != null && _receipt is not "failed" and not "rejected")
                            _receipt = _launched ? "healthy" : "already_running";
                    }
                    // State changes and SSE hints report immediately; routine
                    // presence uses one 30s request, not a busy HTTP poll.
                    bool hinted = _wake.Wait(0);
                    if (_lastState != state || now - _lastReport >= TimeSpan.FromSeconds(30) ||
                        hinted || _receipt != null)
                    {
                        var reply = await Report(state, snapshot?.Instance, stop.Token);
                        failures = 0;
                        _lastReport = now;
                        _lastState = state;
                        if (reply?.Authorized != true) { Log(reply?.Error ?? "authorization_unavailable"); return 0; }
                        if (_receipt is "healthy" or "already_running" or "failed" or "rejected")
                        {
                            _command = null;
                            _launched = false;
                        }
                        _receipt = null;
                        if (reply.Command != null && _command?.Id != reply.Command.Id)
                        {
                            _command = reply.Command;
                            _launched = false;
                            _launchFailed = false;
                            _launchDeadline = now.AddSeconds(45);
                            _detail = null;
                            Nudge();
                        }

                        if (process == null && (!_launchDeadline.HasValue || _command != null && !_launched))
                        {
                            bool requested = _command != null;
                            if (requested && (_command!.ExpiresAt <= DateTimeOffset.UtcNow || _command.AuthorizationId != _grant))
                            {
                                _receipt = "rejected"; _detail = "expired_or_changed_grant"; Nudge();
                            }
                            else if (_budget.TryBegin(now, requested))
                            {
                                // Fresh report above authorized recovery. Recheck
                                // all local gates after that HTTP round trip.
                                if (!Allowed() || !Program.MayLaunch()) continue;
                                _receipt = requested ? "starting" : null;
                                var permission = await Report("starting", snapshot?.Instance, stop.Token);
                                if (permission?.Authorized != true || !Allowed() || !Program.MayLaunch()) continue;
                                // Authorization/claim can expire during the second
                                // HTTP request. Never launch from an old in-memory command.
                                if (requested && (_command!.ExpiresAt <= DateTimeOffset.UtcNow ||
                                    permission.Command?.Id != _command.Id))
                                {
                                    _receipt = "rejected"; _detail = "expired_or_changed_grant"; Nudge(); continue;
                                }
                                try
                                {
                                    using var launched = Process.Start(new ProcessStartInfo(Program.AgentPath, "/background") {
                                        UseShellExecute = false, WorkingDirectory = AppContext.BaseDirectory
                                    });
                                    if (launched == null) throw new InvalidOperationException();
                                    _launched = true;
                                    _launchDeadline = DateTimeOffset.UtcNow.AddSeconds(45);
                                    _launchFailed = false;
                                    _receipt = null;
                                    Log("agent_launch_requested"); // Not a healthy acknowledgement.
                                }
                                catch
                                {
                                    _receipt = requested ? "failed" : null;
                                    _launchFailed = true;
                                    _detail = "agent_launch_failed";
                                    Log(_detail);
                                }
                                Nudge();
                            }
                            else { _launchFailed = true; _detail = "recovery_backoff"; }
                        }
                    }
                    await Task.Delay(1000, stop.Token);
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
                catch
                {
                    // No offline or failed-authorization fallback to Process.Start.
                    failures = Math.Min(5, failures + 1);
                    Log("watch_reporting_failed");
                    var delay = TimeSpan.FromSeconds(Math.Min(30, 1 << failures));
                    // Remain responsive to local withdrawal during backoff.
                    var until = DateTimeOffset.UtcNow + delay;
                    while (Allowed() && !UpdateEnvironment.Pending() && DateTimeOffset.UtcNow < until)
                        await Task.Delay(500, stop.Token);
                }
            }
            if (!Allowed())
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try { await Report(InstallationLifecycle.RemovalRequested() ? "uninstalling" : "disabled",
                    AgentProcessState.Read()?.Instance, deadline.Token, withdrawal: true); }
                catch { Log("withdrawal_report_unavailable"); }
            }
            return 0;
        }
        finally
        {
            stop.Cancel();
            try { await stream; } catch { }
            _http.Dispose();
            _wake.Dispose();
        }
    }

    private async Task<Reply?> Report(string state, string? agent, CancellationToken token, bool withdrawal = false)
    {
        using var request = CompanionAuthorization.Request("/api/public/agent/watch", HttpMethod.Post, !withdrawal);
        if (request == null) return null;
        request.Content = new StringContent(JsonSerializer.Serialize(new {
            Instance = _instance, Sequence = ++_sequence, AuthorizationId = _grant,
            AgentInstance = agent, StartupEnabled = !withdrawal && Allowed(), State = state,
            DetailCode = _detail, CommandId = _command?.Id, CommandState = _receipt,
        }, Json), Encoding.UTF8, "application/json");
        using var response = await _http.SendAsync(request, token);
        response.EnsureSuccessStatusCode();
        var text = await response.Content.ReadAsStringAsync(token);
        if (text.Length > 16_384) throw new InvalidDataException("watch_response_too_large");
        return JsonSerializer.Deserialize<Reply>(text, Json);
    }

    private async Task ListenAsync(CancellationToken token)
    {
        using var http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false })
        { Timeout = Timeout.InfiniteTimeSpan };
        int failures = 0;
        while (!token.IsCancellationRequested && Allowed())
        {
            try
            {
                using var request = CompanionAuthorization.Request("/api/public/agent/stream?component=watch", HttpMethod.Get);
                if (request == null) return;
                using var idle = CancellationTokenSource.CreateLinkedTokenSource(token);
                idle.CancelAfter(TimeSpan.FromSeconds(40));
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, idle.Token);
                response.EnsureSuccessStatusCode();
                using var input = await response.Content.ReadAsStreamAsync(idle.Token);
                using var reader = new StreamReader(input);
                string? line;
                while ((line = await reader.ReadLineAsync(idle.Token)) != null)
                {
                    idle.CancelAfter(TimeSpan.FromSeconds(40));
                    if (line.Length > 4096) throw new InvalidDataException("watch_hint_too_large");
                    if (line is "event: wake" or "event: ready") { failures = 0; Nudge(); }
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch { failures = Math.Min(5, failures + 1); }
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, Math.Max(1, 1 << failures))) +
                TimeSpan.FromMilliseconds(Random.Shared.Next(500)), token);
        }
    }

    internal static void Log(string code)
    {
        try
        {
            var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ConnectLive", "watch.log");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            if (File.Exists(path) && new FileInfo(path).Length > 1_048_576) File.Move(path, path + ".previous", true);
            File.AppendAllText(path, $"{DateTime.UtcNow:O} {code}{Environment.NewLine}");
        }
        catch { /* No credentials or raw server responses are logged. */ }
    }
}
