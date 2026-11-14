// Inert host adapters for compiling the REAL Win32 input dispatcher on Linux.
// No test starts its Windows thread or invokes its P/Invoke input methods.
using System.Text.Json;

namespace ConnectLive.Agent
{
    public sealed class ApiClient
    {
        internal PeerInputPermission LivePermission => throw new NotSupportedException();
        public Task<(long max, List<JsonElement>? items)> PollInputsAsync(string id, long since, CancellationToken token)
            => throw new NotSupportedException();
    }
    internal static class InputBlocker
    {
        public static bool LocalStopPending => false;
        public static readonly IntPtr CONNECTLIVE_INPUT_MAGIC = IntPtr.Zero;
        public static bool CheckWatchdog(TimeSpan duration) => false;
        public static void Release(string reason) { }
    }
    internal static class CurtainController
    {
        public static bool Renew(PeerInputPermission owner) => false;
        public static void Enable(PeerInputPermission owner, Action<bool> receipt) => receipt(false);
        public static void Release(PeerInputPermission owner, string reason) { }
    }
    internal static class CurtainOverlay { public static void Hide() { } }
    internal static class Log
    {
        public static int Warnings;
        public static void Warn(string message) => Warnings++;
        public static void Info(string message) { }
    }
}
namespace System.Windows.Forms { internal static class UnusedPlatformNamespace { } }
namespace System.Windows
{
    internal sealed class Application
    {
        public static Application? Current => null;
        public FakeDispatcher Dispatcher => new();
    }
    internal sealed class FakeDispatcher { public void BeginInvoke(Action action) { } }
}
