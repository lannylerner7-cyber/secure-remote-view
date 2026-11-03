namespace ConnectLive.Agent;

/// <summary>Monotonic, owner-bound lease. Renew cannot reactivate an expired lease.</summary>
internal sealed class CurtainLease
{
    internal const long LifetimeMs = 5000;
    internal object? Owner { get; private set; }
    private long _until;
    internal bool Begin(object owner, long now)
    {
        if (Owner != null && !ReferenceEquals(Owner, owner)) return false;
        Owner = owner;
        _until = now + LifetimeMs;
        return true;
    }
    internal bool Owns(object owner, long now) => ReferenceEquals(Owner, owner) && now < _until;
    internal bool Renew(object owner, long now)
    {
        if (!Owns(owner, now)) return false;
        _until = now + LifetimeMs;
        return true;
    }
    internal bool End(object owner)
    {
        if (!ReferenceEquals(Owner, owner)) return false;
        Owner = null;
        _until = 0;
        return true;
    }
}
