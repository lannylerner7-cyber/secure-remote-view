namespace ConnectLive.Agent;

/// <summary>
/// Per-session receiver guard. Revocation is permanent for this instance:
/// a new session must not revive callbacks holding an older permission.
/// This narrows server mode; it does not establish an enrollment grant.
/// </summary>
internal sealed class PeerInputPermission
{
    private readonly object _gate = new();
    private bool _revoked;
    private bool _control;
    private readonly GrantScopes _scopes;
    private readonly System.Func<bool> _stillValid;
    private readonly System.Threading.CancellationTokenSource _lifetime = new();
    internal System.Threading.CancellationToken Token => _lifetime.Token;

    internal PeerInputPermission(string mode, GrantScopes? scopes = null, System.Func<bool>? stillValid = null)
    {
        _control = mode == "control";
        _scopes = scopes ?? new(false, false, false, false, false);
        _stillValid = stillValid ?? (() => false);
    }

    internal bool Allows(string scope)
    {
        lock (_gate)
            return !_revoked && _stillValid() && _scopes.Allows(scope) && (scope != "control" || _control);
    }

    internal void SetMode(string mode)
    {
        lock (_gate) { if (!_revoked) _control = mode == "control"; }
    }

    internal void Revoke()
    {
        lock (_gate) { _revoked = true; _control = false; }
        // Cancellation callbacks may dispatch UI: never invoke under _gate.
        try { _lifetime.Cancel(); } catch { }
    }

    internal bool TryApply(System.Action apply)
    {
        lock (_gate)
        {
            if (_revoked || !_control || !_scopes.Allows("control") || !_stillValid()) return false;
        }
        // Never hold the permission lock across native/UI callbacks: local
        // withdrawal can run on the UI thread. An already admitted operation
        // can finish, but subsequent callbacks must pass the guard again.
        apply();
        return true;
    }
}
