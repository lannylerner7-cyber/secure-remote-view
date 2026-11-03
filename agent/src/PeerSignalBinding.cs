namespace ConnectLive.Agent;

/// <summary>A viewer connection is replaceable; its session authorization is not.</summary>
internal sealed class PeerSignalBinding(System.Func<bool> sessionAllowed)
{
    private readonly object _gate = new();
    private bool _bound;
    private string? _adminId;
    private string? _peerId;
    internal string? AdminId { get { lock (_gate) return _adminId; } }
    internal string? PeerId { get { lock (_gate) return _peerId; } }

    internal bool TryBind(string? adminId, string? peerId)
    {
        lock (_gate)
        {
            if (!sessionAllowed()) return false;
            _adminId = adminId;
            _peerId = peerId;
            _bound = true;
            return true;
        }
    }

    internal bool Matches(string? adminId, string? peerId)
    {
        lock (_gate) return sessionAllowed() && MatchesLocked(adminId, peerId);
    }

    internal bool TryRelease(string? adminId, string? peerId)
    {
        lock (_gate)
        {
            // Never let an untargeted or old-viewer bye end the current peer.
            if (string.IsNullOrEmpty(adminId) || !sessionAllowed() || !MatchesLocked(adminId, peerId))
                return false;
            _bound = false;
            _adminId = _peerId = null;
            return true;
        }
    }

    private bool MatchesLocked(string? adminId, string? peerId) => _bound &&
        string.Equals(_adminId, adminId, System.StringComparison.Ordinal) &&
        string.Equals(_peerId, peerId, System.StringComparison.Ordinal);
}
