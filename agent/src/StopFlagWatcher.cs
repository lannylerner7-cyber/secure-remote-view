using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ConnectLive.Agent;

/// <summary>
/// User-quit override. %ProgramData%\ConnectLive\stop.flag means "the user
/// explicitly quit ConnectLive" — nothing automatic (the HKCU Run key today,
/// the Watcher in Phase 2) may bring the Agent back while it exists.
///
/// Semantics:
///   • automatic launch (/background, /minimized) + flag present → exit silently
///   • manual launch (no flag args)                              → delete the flag, run
///   • flag appears while running                                → clean shutdown
/// </summary>
public static class StopFlagWatcher
{
    public static readonly string StopFlagPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "ConnectLive", "stop.flag");

    public static bool Exists()
    {
        try { return File.Exists(StopFlagPath); } catch { return false; }
    }

    /// <summary>Called from the tray Exit item — the only explicit quit path.</summary>
    public static void Write()
    {
        try
        {
            var dir = Path.GetDirectoryName(StopFlagPath)!;
            Directory.CreateDirectory(dir);
            File.WriteAllText(StopFlagPath, DateTime.UtcNow.ToString("o"));
            Log.Info("stop.flag written (user requested exit)");
        }
        catch (Exception ex) { Log.Warn($"stop.flag write: {ex.Message}"); }
    }

    /// <summary>A manual launch is an explicit opt-back-in: clear the override.</summary>
    public static void Clear()
    {
        try { if (File.Exists(StopFlagPath)) File.Delete(StopFlagPath); } catch { }
    }

    /// <summary>
    /// Polls for a flag written after we started (e.g. by a second instance's
    /// Exit, or by tooling) and shuts the process down cleanly.
    /// </summary>
    public static void Start(CancellationToken ct)
    {
        var started = DateTime.UtcNow;

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
                            Log.Info("stop.flag detected — shutting down");
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
