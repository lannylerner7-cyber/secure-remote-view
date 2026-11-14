namespace ConnectLive.Agent;

/// <summary>Bounded diagnostic metadata; never window titles, pixels or credentials.</summary>
internal readonly record struct CurtainApplyResult(bool Applied, string? Reason = null, int? NativeError = null)
{
    internal static CurtainApplyResult Success => new(true);
    internal static CurtainApplyResult Failed(string reason, int? nativeError = null) =>
        new(false, reason, nativeError is > 0 and <= 65535 ? nativeError : null);
}
