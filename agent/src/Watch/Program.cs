using System.Diagnostics;
using ConnectLive.Agent;
using System.Security.Principal;

namespace ConnectLive.Watch;

/// <summary>Opted-in, interactive-user recovery only. Never enrolls, elevates, or clears withdrawal.</summary>
internal static class Program
{
    internal static string AgentPath => Path.Combine(AppContext.BaseDirectory, "ConnectLive.exe");

    public static int Main()
    {
        if (!StartupConsent.IsAllowed()) return 0;
        // Keep mutex ownership on this thread across the asynchronous runner.
        using var singleton = new Mutex(false, @"Local\ConnectLive.Watch." + WindowsIdentity.GetCurrent().User!.Value);
        bool acquired;
        try { acquired = singleton.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) return 0;
        try
        {
            if (UpdateEnvironment.Pending())
            {
                UpdateEnvironment.StartRecovery();
                return 0; // A planned update is not reported as an Agent crash.
            }
            return new WatchRunner().RunAsync().GetAwaiter().GetResult();
        }
        catch { WatchRunner.Log("watch_failed"); return 1; }
        finally { singleton.ReleaseMutex(); }
    }

    internal static Process? FindAgent()
    {
        foreach (var process in Process.GetProcessesByName("ConnectLive"))
        {
            try
            {
                if (!process.HasExited && process.SessionId == Process.GetCurrentProcess().SessionId &&
                    string.Equals(process.MainModule?.FileName, AgentPath, StringComparison.OrdinalIgnoreCase))
                    return process;
            }
            catch { process.Dispose(); throw; }
            process.Dispose();
        }
        return null;
    }

    internal static bool MayLaunch()
    {
        if (!StartupConsent.IsAllowed() || UpdateEnvironment.Pending() || !File.Exists(AgentPath)) return false;
        using var process = FindAgent();
        if (process != null) return false;
        using var mutex = new Mutex(false, @"Global\ConnectLive.Agent");
        bool acquired;
        try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
        if (acquired) mutex.ReleaseMutex();
        return acquired; // The replacement still acquires the Agent's real mutex itself.
    }
}
