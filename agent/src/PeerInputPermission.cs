namespace ConnectLive.Agent;

/// <summary>
/// Per-session receiver guard. Revocation is permanent for this instance:
/// a new session must not revive callbacks holding an older permission.
/// This narrows server mode; it does not establish an enrollment grant.
/// </summary>
internal sealed class PeerInputPermission
{
    // Installed by the Windows host; isolated policy tests need no Win32 APIs.
    internal static System.Func<bool> SensitiveDesktop = () => false;
    internal static System.Func<bool> LockedDesktop = () => false;
    private static bool DesktopAllows(string scope)
    {
        if (scope == "view") return true;
        try { return !SensitiveDesktop() && (scope != "control" || !LockedDesktop()); } catch { return false; }
    }
    private readonly object _gate = new();
    private bool _revoked;
    private bool _control;
    private long _modeObservation;
    private readonly GrantScopes _scopes;
    private readonly System.Func<bool> _stillValid;
    private readonly System.Func<string, bool>? _parentAllows;
    private readonly InputPauseGate _input;
    private System.Threading.CancellationTokenRegistration? _parentCancellation;
    private readonly System.Threading.CancellationTokenSource _lifetime = new();
    internal System.Threading.CancellationToken Token => _lifetime.Token;

    internal PeerInputPermission(string mode, GrantScopes? scopes = null, System.Func<bool>? stillValid = null,
        System.Func<string, bool>? parentAllows = null, System.Func<bool>? releaseInputs = null,
        InputPauseGate? inputGate = null)
    {
        _control = mode == "control";
        _scopes = scopes ?? new(false, false, false, false, false);
        _stillValid = stillValid ?? (() => false);
        _parentAllows = parentAllows;
        _input = inputGate ?? new InputPauseGate(releaseInputs);
    }

    internal bool Allows(string scope)
    {
        lock (_gate)
            return !_revoked && _stillValid() && (_parentAllows == null || _parentAllows(scope)) &&
                _scopes.Allows(scope) && (scope != "control" || _control) && DesktopAllows(scope);
    }

    // Child callbacks are revoked with their peer without revoking capture or
    // the signaling pump. Parent mode changes/revocation still apply immediately.
    internal PeerInputPermission Fork()
    {
        var child = new PeerInputPermission("control", _scopes, () => true, Allows, inputGate: _input);
        var registration = Token.Register(child.Revoke);
        child._parentCancellation = registration;
        if (child.Token.IsCancellationRequested) registration.Unregister();
        return child;
    }

    internal void SetMode(string mode)
    {
        SetMode(mode, System.Diagnostics.Stopwatch.GetTimestamp());
    }

    // A slow heartbeat begun BEFORE a targeted permission read must not undo
    // its newer result when it eventually returns.
    internal bool SetMode(string mode, long observationStarted)
    {
        bool lostControl;
        lock (_gate)
        {
            if (_revoked || observationStarted < _modeObservation) return false;
            _modeObservation = observationStarted;
            lostControl = _control && mode != "control";
            _control = mode == "control";
        }
        // Do not hold the permission lock while draining native input.
        if (lostControl) _input.Block("view_only");
        return true;
    }

    internal void Revoke()
    {
        lock (_gate)
        {
            if (_revoked) return;
            _revoked = true; _control = false;
        }
        _input.Block("authorization_changed");
        _parentCancellation?.Unregister();
        // Cancellation callbacks may dispatch UI: never invoke under _gate.
        try { _lifetime.Cancel(); } catch { }
    }

    internal bool TryApply(System.Action apply)
        => TryApplyCapability("control", apply);

    internal InputPauseSnapshot InputState => _input.State;
    internal bool PauseInput(string epoch, long revision)
        => Allows("view") && _input.Pause(epoch, revision);
    internal bool ResumeInput(string epoch, long revision)
        => _input.Resume(epoch, revision, () => Allows("control"));
    internal bool TryApplyInput(string? epoch, System.Action apply)
        => _input.Apply(epoch, () => Allows("control"), apply);

    internal bool TryApplyCapability(string scope, System.Action apply)
    {
        lock (_gate)
        {
            if (_revoked || !_scopes.Allows(scope) || !DesktopAllows(scope) || (scope == "control" && !_control) || !_stillValid() ||
                (_parentAllows != null && !_parentAllows(scope))) return false;
        }
        // Never hold the permission lock across native/UI callbacks: local
        // withdrawal can run on the UI thread. An already admitted operation
        // can finish, but subsequent callbacks must pass the guard again.
        apply();
        return true;
    }
}
