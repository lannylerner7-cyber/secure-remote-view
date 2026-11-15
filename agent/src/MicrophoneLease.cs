using System;
using System.Collections.Generic;

namespace ConnectLive.Agent;

/// <summary>Independent, fail-closed microphone lease. No implicit start on renew.</summary>
internal sealed class MicrophoneLease(Func<long> clock)
{
    private readonly object _gate = new();
    private readonly HashSet<string> _used = new();
    private string? _id;
    private long _browser, _authority;
    private long _generation;
    internal long Generation { get { lock(_gate) return _generation; } }
    internal bool Start(string id, bool consent, bool current, long? requestedGeneration = null)
    {
        lock (_gate)
        {
            if (!consent || !current || (requestedGeneration.HasValue && requestedGeneration.Value != _generation) ||
                _id != null || _used.Count >= 256 || !_used.Add(id)) return false;
            _id = id; _browser = _authority = clock(); return true;
        }
    }
    internal bool RenewBrowser(string id)
    {
        lock (_gate) { if (_id != id) return false; _browser = clock(); return true; }
    }
    internal void Authority(string id) { lock (_gate) if (_id == id) _authority = clock(); }
    internal bool Allowed(string id, bool consent, bool current)
    {
        lock (_gate) return _id == id && consent && current &&
            clock() - _browser < 5000 && clock() - _authority < 5000;
    }
    internal void Stop() { lock (_gate) { _id = null; _generation++; } }
}
