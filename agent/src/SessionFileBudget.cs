using System;
using System.Collections.Generic;

namespace ConnectLive.Agent;

/// <summary>Retained across peer replacement. Reservations never silently reset.</summary>
internal sealed class SessionFileBudget
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (long Size, string Sha)> _ids = new();
    private long _bytes;
    internal bool Reserve(VerifiedFileInfo file)
    {
        lock (_gate)
        {
            // Even identical IDs are not replayed as a fresh filesystem write.
            if (_ids.ContainsKey(file.id) || _ids.Count >= 512 ||
                file.size < 0 || file.size > FileTransfer.MaxFileBytes || _bytes + file.size > VerifiedFile.SessionLimit)
                return false;
            _ids.Add(file.id, (file.size, file.sha256)); _bytes += file.size; return true;
        }
    }
}
