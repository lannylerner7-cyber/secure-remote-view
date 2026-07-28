using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

/// <summary>
/// Boss/Worker exit signal. The Watcher (LocalSystem) drops
/// %ProgramData%\ConnectLive\stop.flag when the active session ends and no
/// session binding remains, so the user-session Agent can shut down cleanly
/// and stop consuming CPU. The Agent polls it every 2 s.
///
/// We only honour the flag when it's newer than our own process start time
/// — otherwise a stale flag left over from the previous session would kill
/// the Agent the moment the Watcher wakes it back up.
/// </summary>
public static class StopFlagWatcher
{
    private static readonly string StopFlagPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "ConnectLive", "stop.flag");

    public static void Start(CancellationToken ct)
    {
        var started = DateTime.UtcNow;

        // Best-effort: remove a pre-existing stop.flag we inherited from a
        // prior session so it can't race us at boot.
        try { if (File.Exists(StopFlagPath)) File.Delete(StopFlagPath); } catch { }

        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    if (File.Exists(StopFlagPath))
                    {
                        var writtenUtc = File.GetLastWriteTimeUtc(StopFlagPath);
                        if (writtenUtc >= started)
                        {
                            Log.Info("stop.flag detected — Watcher requested shutdown");
                            try { File.Delete(StopFlagPath); } catch { }
                            Application.Current?.Dispatcher.Invoke(() =>
                            {
                                Application.Current?.Shutdown();
                            });
                            return;
                        }
                    }
                }
                catch (Exception ex) { Log.Warn($"stop.flag poll: {ex.Message}"); }
                try { await Task.Delay(2000, ct); } catch { return; }
            }
        }, ct);
    }
}
