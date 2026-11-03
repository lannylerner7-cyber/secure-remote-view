using System;
using System.Collections.Generic;

namespace ConnectLive.Agent;

/// <summary>At most three automatic launches in ten minutes, with increasing delay.</summary>
internal sealed class RecoveryBudget
{
    private readonly Queue<DateTimeOffset> _attempts = new();
    private DateTimeOffset _next;
    internal bool TryBegin(DateTimeOffset now, bool explicitlyRequested)
    {
        while (_attempts.TryPeek(out var oldest) && now - oldest >= TimeSpan.FromMinutes(10))
            _attempts.Dequeue();
        if (!explicitlyRequested && (_attempts.Count >= 3 || now < _next)) return false;
        _attempts.Enqueue(now);
        _next = now.AddSeconds(_attempts.Count == 1 ? 5 : _attempts.Count == 2 ? 30 : 60);
        return true;
    }
}
