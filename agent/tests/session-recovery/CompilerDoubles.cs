namespace ConnectLive.Agent;

// Only support compile-checking the production MF wrapper on Linux.
// The tests never initialize a transform or claim native encoding.
internal static class CodecPolicy { internal static bool AllowH264 => false; }
internal static class HwEncoderProbe { internal static string VendorTag => "not-executed"; }
internal static class Log
{
    internal static void Info(string _) { }
    internal static void Warn(string _) { }
}
