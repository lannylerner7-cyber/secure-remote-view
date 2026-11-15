using System.Threading;

namespace ConnectLive.Agent;

/// <summary>On-device approval has no credential retrieval or input adapter.</summary>
internal static class AppVerification
{
    private static object? _owner;
    internal static bool Active => Volatile.Read(ref _owner) != null;
    internal static bool Begin(object owner) => Interlocked.CompareExchange(ref _owner, owner, null) == null;
    internal static void End(object owner) => Interlocked.CompareExchange(ref _owner, null, owner);
}
