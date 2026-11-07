using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

// Kept separate from Windows storage/UI so the actual authenticated send path
// can run in a portable, fake-transport test without building the Agent.
public sealed partial class ApiClient
{
    private readonly object _identityGate = new();
    private readonly TimeProvider _identityTime = TimeProvider.System;
    private long _tokenGeneration;
    private DateTimeOffset _revokedUntilUtc = DateTimeOffset.MinValue;

    /// <summary>One fixed diagnostic per rejection cooldown. A 401 stops live
    /// authority, but is never permission to delete pairing or enroll again.</summary>
    public event Action<string>? OnEnrollmentRevoked;

    // Called only after explicit foreground pairing has durably saved both
    // credentials and the matching local grant.
    private void SetPairedIdentity(string deviceId, string deviceToken, LocalGrant local)
    {
        lock (_identityGate)
        {
            DeviceId = deviceId;
            DeviceToken = deviceToken;
            LocalAuthorization = local;
            _tokenGeneration++;
            _revokedUntilUtc = DateTimeOffset.MinValue;
        }
    }

    // Exactly one attempt. In particular, never replay a frame, signal, file,
    // consent, revocation or attestation under a newly enrolled identity.
    // Callers own the returned response; requests are disposed on every path.
    private async Task<HttpResponseMessage> SendAuthedAsync(Func<HttpRequestMessage> build, CancellationToken ct,
        AgentHttpOperation? diagnosticOperation = null, CancellationToken? lifetime = null)
    {
        ct.ThrowIfCancellationRequested();
        string deviceId, deviceToken;
        long generation;
        lock (_identityGate)
        {
            if (_identityTime.GetUtcNow() < _revokedUntilUtc)
                throw new HttpRequestException("Device identity rejected; waiting for cooldown.", null, HttpStatusCode.Unauthorized);
            if (string.IsNullOrEmpty(DeviceId) || string.IsNullOrEmpty(DeviceToken))
                throw new HttpRequestException("Explicit device pairing is required.", null, HttpStatusCode.Unauthorized);
            deviceId = DeviceId;
            deviceToken = DeviceToken;
            generation = _tokenGeneration;
        }

        using var req = build();
        req.Headers.Add("X-Device-Id", deviceId);
        req.Headers.Add("X-Device-Token", deviceToken);
        var resp = diagnosticOperation is { } operation
            ? await _httpDiagnostics.SendAsync(_http, req, operation, ct, lifetime ?? ct, 1)
            : await _http.SendAsync(req, ct);

        // 503, other failures and transport exceptions leave the saved identity
        // and grant untouched. A failed heartbeat still tears down all live
        // channels in Agent.HeartbeatLoop; recovery must validate authority again.
        if (resp.StatusCode is not (HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)) return resp;

        bool reportRejection = false;
        lock (_identityGate)
        {
            // An old in-flight rejection cannot invalidate a later explicit
            // pairing. Its original failed response is still returned, not retried.
            if (generation != _tokenGeneration) return resp;
            if (resp.StatusCode == HttpStatusCode.Unauthorized)
            {
                var now = _identityTime.GetUtcNow();
                reportRejection = now >= _revokedUntilUtc;
                if (reportRejection) _revokedUntilUtc = now.AddSeconds(60);
            }
        }
        LivePermission?.Revoke();
        try { LiveAuthorityRejected?.Invoke(); } catch { }
        if (reportRejection)
            try { OnEnrollmentRevoked?.Invoke("Device identity rejected; remote access is closed. Verify the existing pairing."); } catch { }
        return resp;
    }
}
