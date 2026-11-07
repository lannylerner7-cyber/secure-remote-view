using System;
using System.IO;
using System.Threading;

namespace ConnectLive.Agent;

/// <summary>
/// A completed support visit needs a new foreground pairing. This marker
/// keeps that requirement across restarts without deleting the saved identity
/// or misclassifying an HTTP/WebRTC outage as revocation.
/// </summary>
internal static class SessionPairingRequirement
{
    private static string MarkerPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ConnectLive", "session-pairing-required");

    private static int _required = -1;
    // Companions are separate processes; they must observe changes made by
    // the Agent, rather than reuse their process-local cache.
    internal static bool RequiredOnDisk => LocalAccessState.IsDisabledAt(MarkerPath);
    internal static bool Required
    {
        get
        {
            if (Volatile.Read(ref _required) < 0)
                Interlocked.CompareExchange(ref _required, RequiredOnDisk ? 1 : 0, -1);
            return Volatile.Read(ref _required) == 1;
        }
    }
    internal static void Require()
    {
        Volatile.Write(ref _required, 1);
        LocalAccessState.DisableAt(MarkerPath);
    }

    internal static void CompleteForegroundPairing()
    {
        File.Delete(MarkerPath);
        if (LocalAccessState.IsDisabledAt(MarkerPath))
            throw new IOException("Could not save the completed pairing; remote access remains stopped.");
        Volatile.Write(ref _required, 0);
    }
}
