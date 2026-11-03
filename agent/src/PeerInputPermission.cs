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
    private readonly System.Func<string, bool>? _parentAllows;
    private System.Threading.CancellationTokenRegistration? _parentCancellation;
    private readonly System.Threading.CancellationTokenSource _lifetime = new();
    internal System.Threading.CancellationToken Token => _lifetime.Token;

    internal PeerInputPermission(string mode, GrantScopes? scopes = null, System.Func<bool>? stillValid = null,
        System.Func<string, bool>? parentAllows = null)
    {
        _control = mode == "control";
        _scopes = scopes ?? new(false, false, false, false, false);
        _stillValid = stillValid ?? (() => false);
        _parentAllows = parentAllows;
    }

    internal bool Allows(string scope)
    {
        lock (_gate)
            return !_revoked && _stillValid() && (_parentAllows == null || _parentAllows(scope)) &&
                _scopes.Allows(scope) && (scope != "control" || _control);
    }

    // Child callbacks are revoked with their peer without revoking capture or
    // the signaling pump. Parent mode changes/revocation still apply immediately.
    internal PeerInputPermission Fork()
    {
        var child = new PeerInputPermission("control", _scopes, () => true, Allows);
        var registration = Token.Register(child.Revoke);
        child._parentCancellation = registration;
        if (child.Token.IsCancellationRequested) registration.Unregister();
        return child;
    }

    internal void SetMode(string mode)
    {
        lock (_gate) { if (!_revoked) _control = mode == "control"; }
    }

    internal void Revoke()
    {
        lock (_gate) { _revoked = true; _control = false; }
        _parentCancellation?.Unregister();
        // Cancellation callbacks may dispatch UI: never invoke under _gate.
        try { _lifetime.Cancel(); } catch { }
    }

    internal bool TryApply(System.Action apply)
        => TryApplyCapability("control", apply);

    internal bool TryApplyCapability(string scope, System.Action apply)
    {
        lock (_gate)
        {
            if (_revoked || !_scopes.Allows(scope) || (scope == "control" && !_control) || !_stillValid() ||
                (_parentAllows != null && !_parentAllows(scope))) return false;
        }
        // Never hold the permission lock across native/UI callbacks: local
        // withdrawal can run on the UI thread. An already admitted operation
        // can finish, but subsequent callbacks must pass the guard again.
        apply();
        return true;
    }
}
