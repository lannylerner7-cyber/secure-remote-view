// UI/elevation adapters only. Real registry, DPAPI and process code is compiled
// but must not execute in this portable harness.
namespace ConnectLive.Agent
{
    internal static class UpdateEnvironment
    {
        internal static string UserInstall => Path.Combine(Path.GetTempPath(), "Programs", "ConnectLive");
        internal static bool IsElevated() => throw new InvalidOperationException("Windows elevation must not run in this harness.");
    }
    internal static class Log
    {
        internal static void Info(string message) { }
        internal static void Warn(string message) { }
    }
}
namespace System.Windows
{
    public enum MessageBoxButton { YesNo, OK }
    public enum MessageBoxImage { Question, Information, Warning }
    public enum MessageBoxResult { No, Yes }
    public static class MessageBox
    {
        public static MessageBoxResult Show(string message, string title, MessageBoxButton buttons,
            MessageBoxImage image, MessageBoxResult defaultResult = MessageBoxResult.No) =>
            throw new InvalidOperationException("Windows UI must not run in this harness.");
    }
}
