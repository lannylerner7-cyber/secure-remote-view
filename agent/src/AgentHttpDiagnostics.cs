using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

internal enum AgentHttpOperation { Frame, Heartbeat }

/// <summary>
/// Bounded metadata-only observations of individual HTTP attempts. No URLs,
/// request/response bodies, credentials, device IDs or exception messages.
/// Independent of Windows so the actual observer can be tested with a fake handler.
/// </summary>
internal sealed class AgentHttpDiagnostics
{
    private const string RequestIdHeader = "X-ConnectLive-Request-Id";
    private const long WindowMs = 60_000;
    private readonly Action<string, bool> _write;
    private readonly Func<long> _now;
    private readonly object _gate = new();
    private readonly State _frame = new(), _heartbeat = new();
    private sealed class State
    {
        public long WindowAt = -WindowMs, HealthyAt = -WindowMs;
        public int Emitted, Suppressed, Failures, Recovery;
    }

    internal AgentHttpDiagnostics(Action<string, bool> write, Func<long>? now = null)
    {
        _write = write;
        _now = now ?? (() => Environment.TickCount64);
    }

    internal async Task<HttpResponseMessage> SendAsync(
        HttpClient client, HttpRequestMessage request, AgentHttpOperation operation,
        CancellationToken requestToken, CancellationToken lifetimeToken, int attempt)
    {
        var id = "clh-" + Guid.NewGuid().ToString("N");
        request.Headers.Add(RequestIdHeader, id);
        var watch = Stopwatch.StartNew();
        try
        {
            // Keep ResponseContentRead: the existing HttpClient timeout covers
            // the entire response, not just headers. Do not add a retry here.
            var response = await client.SendAsync(request, requestToken).ConfigureAwait(false);
            Record(operation, id, attempt, response.IsSuccessStatusCode ? "ok" : "http_error",
                (int)response.StatusCode, watch.ElapsedMilliseconds, response);
            return response;
        }
        catch (Exception ex)
        {
            Record(operation, id, attempt,
                FailureCategory(ex, lifetimeToken.IsCancellationRequested, requestToken.IsCancellationRequested),
                ex is HttpRequestException { StatusCode: { } status } ? (int)status : 0,
                watch.ElapsedMilliseconds, null);
            throw; // Heartbeat failures must still reach the fail-closed coordinator.
        }
    }

    internal static string FailureCategory(Exception ex, bool lifetimeCancelled = false, bool deadlineCancelled = false)
    {
        if (ex is OperationCanceledException)
        {
            if (lifetimeCancelled) return "cancelled";
            if (deadlineCancelled) return "deadline";
            return ex.InnerException is TimeoutException ? "http_timeout" : "cancelled_unknown";
        }
        if (ex is HttpRequestException http)
        {
            if (http.StatusCode.HasValue) return "http_error";
            return http.HttpRequestError switch
            {
                HttpRequestError.NameResolutionError => "dns_error",
                HttpRequestError.ConnectionError => "connection_error",
                HttpRequestError.SecureConnectionError => "tls_error",
                HttpRequestError.HttpProtocolError => "protocol_error",
                HttpRequestError.ProxyTunnelError => "proxy_error",
                HttpRequestError.ResponseEnded => "response_ended",
                HttpRequestError.InvalidResponse => "invalid_response",
                _ => "transport_error",
            };
        }
        return "unexpected_error";
    }

    internal static string SafeFailure(Exception ex, bool lifetimeCancelled = false) =>
        ex is HttpRequestException { StatusCode: { } status }
            ? $"HTTP {(int)status}" : FailureCategory(ex, lifetimeCancelled);

    private static readonly HashSet<string> Stages = new(StringComparer.Ordinal)
    {
        "handler", "device_auth", "request_body", "session_lookup", "session_authorization",
        "frame_write", "authorization", "runtime_write", "presence_write", "license_lookup",
        "license_evaluation", "license_state_write", "sessions_lookup", "session_cleanup", "session_status_lookup",
        "commands_lookup", "commands_dispatch", "notification_write",
    };
    private static readonly HashSet<string> Outcomes = new(StringComparer.Ordinal)
    {
        "ok", "unauthorized", "device_lookup_unavailable", "invalid_frame", "session_lookup_unavailable",
        "not_found", "video_only_session", "not_active", "session_authorization_unavailable",
        "frame_write_failed", "authorization_unavailable", "invalid_runtime_report",
        "runtime_reporting_unavailable", "retired_or_stale_process", "presence_write_failed",
        "license_unavailable", "license_state_write_failed", "sessions_unavailable",
        "session_cleanup_failed", "notification_failed", "invalid_observed_session", "handler_exception", "client_aborted",
    };

    private static string? Header(HttpResponseMessage? response, string name)
    {
        if (response == null || !response.Headers.TryGetValues(name, out var values)) return null;
        foreach (var value in values) return value.Length <= 80 ? value : null;
        return null;
    }
    private static string AllowedHeader(HttpResponseMessage? response, string name, HashSet<string> allowed)
    {
        var value = Header(response, name);
        return value != null && allowed.Contains(value) ? value : "none";
    }

    private void Record(AgentHttpOperation operation, string id, int attempt, string outcome,
        int status, long elapsedMs, HttpResponseMessage? response)
    {
        // Logger or malformed diagnostic headers must not affect permissions,
        // response handling, the frame pump, or the heartbeat deadline.
        try
        {
            var serverSeen = Header(response, RequestIdHeader) == id;
            var serverMs = Header(response, "X-ConnectLive-Server-Ms");
            if (!long.TryParse(serverMs, NumberStyles.None, CultureInfo.InvariantCulture, out var ms) ||
                ms < 0 || ms > 86_400_000) serverMs = "none";
            else serverMs = ms.ToString(CultureInfo.InvariantCulture);
            var stage = AllowedHeader(response, "X-ConnectLive-Stage", Stages);
            var serverOutcome = AllowedHeader(response, "X-ConnectLive-Outcome", Outcomes);
            var slowestStage = AllowedHeader(response, "X-ConnectLive-Slowest-Stage", Stages);
            var slowestMs = Header(response, "X-ConnectLive-Slowest-Ms");
            if (!long.TryParse(slowestMs, NumberStyles.None, CultureInfo.InvariantCulture, out var slowMs) ||
                slowMs < 0 || slowMs > 86_400_000) slowestMs = "none";
            else slowestMs = slowMs.ToString(CultureInfo.InvariantCulture);
            var protocol = Header(response, "X-ConnectLive-Live-Protocol");
            if (!int.TryParse(protocol, NumberStyles.None, CultureInfo.InvariantCulture, out var version) ||
                version < 1 || version > 1000) protocol = "unreported";
            else protocol = version.ToString(CultureInfo.InvariantCulture);
            lock (_gate)
            {
                var state = operation == AgentHttpOperation.Frame ? _frame : _heartbeat;
                var now = _now();
                var failure = outcome is not ("ok" or "cancelled");
                if (failure) state.Failures = Math.Min(1_000_000_000, state.Failures + 1);
                else if (outcome == "ok" && state.Failures > 0)
                {
                    state.Recovery = Math.Min(1_000_000_000, state.Recovery + state.Failures);
                    state.Failures = 0;
                }
                var problem = failure || state.Recovery > 0 ||
                    (outcome == "ok" && elapsedMs >= (operation == AgentHttpOperation.Frame ? 2_000 : 10_000));
                if (problem)
                {
                    if (now - state.WindowAt >= WindowMs) { state.WindowAt = now; state.Emitted = 0; }
                    if (state.Emitted >= 6)
                    {
                        state.Suppressed = Math.Min(1_000_000_000, state.Suppressed + 1);
                        return;
                    }
                    state.Emitted++;
                }
                else
                {
                    if (now - state.HealthyAt < WindowMs) return;
                    state.HealthyAt = now;
                }
                _write($"HTTP op={(operation == AgentHttpOperation.Frame ? "frame" : "heartbeat")}" +
                    $" request={id} attempt={attempt} outcome={outcome}" +
                    $" status={(status == 0 ? "none" : status.ToString(CultureInfo.InvariantCulture))}" +
                    $" elapsed_ms={Math.Clamp(elapsedMs, 0, 86_400_000)}" +
                    $" budget_ms={(operation == AgentHttpOperation.Frame ? 3_000 : 20_000)}" +
                    $" server_seen={serverSeen.ToString().ToLowerInvariant()} server_ms={serverMs}" +
                    $" server_stage={stage} server_outcome={serverOutcome}" +
                    $" slowest_stage={slowestStage} slowest_ms={slowestMs} server_protocol={protocol}" +
                    $" failures={state.Failures} recovered_after={state.Recovery} suppressed={state.Suppressed}",
                    failure || (problem && state.Recovery == 0));
                state.Suppressed = 0;
                state.Recovery = 0;
            }
        }
        catch { /* Metadata only; do not change the HTTP result. */ }
    }
}
