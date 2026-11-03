using System.Diagnostics;
using System.Text.Json;
using ConnectLive.Agent;
using ConnectLive.Updates;

namespace ConnectLive.UpdateHost;

internal static class Program
{
    // Mutex ownership stays on this synchronous entry thread across async work.
    public static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || UpdateEnvironment.IsElevated() ||
            args.Length != 2 || args[0] is not ("--apply" or "--recover")) return 2;
        using var gate = new Mutex(false, UpdateEnvironment.MutexName);
        bool acquired;
        try { acquired = gate.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) return 0;
        try { return Run(args).GetAwaiter().GetResult(); }
        catch { return 1; } // Journal, not exception strings/credentials, is the diagnostic source.
        finally { gate.ReleaseMutex(); }
    }

    private static async Task<int> Run(string[] args)
    {
        var directory = UpdateEnvironment.JobPath(args[1]);
        var journal = UpdateJournal.Read(Path.Combine(directory, "journal.json"));
        if (journal.Id != args[1] || !UpdateEnvironment.IsUserInstall(journal.InstallDirectory)) return 2;
        // Avoid redirecting backup/copy operations through filesystem junctions.
        foreach (var path in new[] { directory, journal.InstallDirectory, UpdateEnvironment.Root })
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return 2;
        if (journal.IsTerminal)
        {
            // Recover a crash between terminal journal write and pending-marker cleanup.
            CleanTerminalJob(directory, journal);
            ResumeWatch(journal);
            return 0;
        }
        using var runtime = new WindowsRuntime(directory, journal);
        var transaction = new UpdateTransaction(directory, journal, runtime);
        if (args[0] == "--recover" || journal.Phase != "prepared")
        {
            await transaction.Recover(CancellationToken.None);
            CleanTerminalJob(directory, journal);
            ResumeWatch(journal);
            return 0;
        }
        var key = UpdatePackage.InstalledPublisherKey() ?? throw new InvalidDataException("No installed publisher key");
        var stage = Path.Combine(directory, "verified-" + Guid.NewGuid().ToString("N"));
        var package = UpdatePackage.VerifyAndExtract(Path.Combine(directory, "package.zip"), stage, key,
            journal.Version, journal.ArchiveSha256);
        // Signal readiness only after signature verification and worker startup.
        ConfigFile.Write(Path.Combine(directory, "worker-ready"), journal.Id);
        var applied = await transaction.Apply(package, CancellationToken.None);
        if (applied) runtime.CommitCandidate();
        CleanTerminalJob(directory, journal);
        ResumeWatch(journal);
        return applied ? 0 : 1;
    }

    private static void ResumeWatch(UpdateJournal journal)
    {
        if (!journal.IsTerminal || UpdateEnvironment.Pending() || !StartupConsent.IsAllowed()) return;
        var path = Path.Combine(journal.InstallDirectory, "ConnectLiveWatch.exe");
        if (!File.Exists(path)) return;
        // The companion owns its per-user singleton mutex. The scheduled task
        // remains a fallback if this best-effort launch fails.
        try
        {
            using var watch = Process.Start(new ProcessStartInfo(path) {
                UseShellExecute = false, WorkingDirectory = journal.InstallDirectory
            });
        }
        catch { Console.Error.WriteLine("watch_resume_deferred"); }
    }

    private static void CleanTerminalJob(string directory, UpdateJournal journal)
    {
        if (!journal.IsTerminal) return;
        if (journal.Failure == "local_withdrawal")
        {
            var held = Path.Combine(UpdateEnvironment.Root, "attempted-version");
            if (File.Exists(held) && File.ReadAllText(held).Trim() == journal.Version) File.Delete(held);
        }
        // Keep the rollback inventory/runner, not duplicate downloaded payloads.
        foreach (var subdirectory in Directory.EnumerateDirectories(directory))
        {
            var name = Path.GetFileName(subdirectory);
            if (name == "stage" || name.StartsWith("verified-", StringComparison.Ordinal))
                try { Directory.Delete(subdirectory, true); } catch { }
        }
        try { File.Delete(Path.Combine(directory, "package.zip")); } catch { }
    }

    private sealed class WindowsRuntime(string directory, UpdateJournal journal) : IUpdateRuntime, IDisposable
    {
        private CandidateProcess? _candidate;
        public void CommitCandidate() => _candidate?.Commit();
        public void Dispose() => _candidate?.Dispose();
        private string AgentPath => Path.Combine(journal.InstallDirectory, "ConnectLive.exe");
        public bool LocalAuthorizationAllowsRestart() => StartupConsent.IsAllowed();

        public async Task WaitForOldProcessExit(CancellationToken cancellation)
        {
            // Watch is now resident. Pending update state asks it to exit;
            // never replace its executable while it still owns the companion
            // mutex. There is no process-name kill or elevated fallback.
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            {
                deadline.CancelAfter(TimeSpan.FromSeconds(30));
                var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value;
                while (true)
                {
                    deadline.Token.ThrowIfCancellationRequested();
                    if (!StartupConsent.IsAllowed()) throw new OperationCanceledException("Local authorization withdrawn");
                    using var watch = new Mutex(false, @"Local\ConnectLive.Watch." + sid);
                    bool available;
                    try { available = watch.WaitOne(0); } catch (AbandonedMutexException) { available = true; }
                    if (available) { watch.ReleaseMutex(); break; }
                    await Task.Delay(200, deadline.Token);
                }
            }
            try
            {
                using var parent = Process.GetProcessById(journal.ParentPid);
                if (parent.StartTime.ToUniversalTime().Ticks == journal.ParentStartTicks)
                {
                    if (!string.Equals(parent.MainModule?.FileName, AgentPath, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Update parent is not this installation");
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    deadline.CancelAfter(TimeSpan.FromSeconds(60));
                    await parent.WaitForExitAsync(deadline.Token);
                }
            }
            catch (ArgumentException) { } // Original process has already exited.
            if (journal.Phase == "waiting_for_exit" &&
                (!File.Exists(Path.Combine(directory, "commit")) ||
                 File.ReadAllText(Path.Combine(directory, "commit")) != journal.Id))
                throw new OperationCanceledException("No idle handoff was authorized");
        }

        public async Task<bool> LaunchAndConfirmHealth(UpdateJournal state, CancellationToken cancellation)
        {
            if (!LocalAuthorizationAllowsRestart()) return false;
            var healthPath = Path.Combine(directory, "health.json");
            if (File.Exists(healthPath)) File.Delete(healthPath);
            _candidate = CandidateProcess.Start(AgentPath,
                $"/background /update-job {state.Id} /update-health {state.HealthNonce}", journal.InstallDirectory);
            var candidate = _candidate.Process;
            state.CandidatePid = candidate.Id;
            state.CandidateStartTicks = candidate.StartTime.ToUniversalTime().Ticks;
            state.Save(Path.Combine(directory, "journal.json"));
            if (!LocalAuthorizationAllowsRestart()) return false;
            _candidate.Resume();
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(90))
            {
                cancellation.ThrowIfCancellationRequested();
                if (!LocalAuthorizationAllowsRestart() || candidate.HasExited) return false;
                if (File.Exists(healthPath) && new FileInfo(healthPath).Length <= 2048)
                {
                    try
                    {
                        var health = JsonSerializer.Deserialize<UpdateEnvironment.HealthReceipt>(File.ReadAllBytes(healthPath));
                        if (health != null && health.JobId == state.Id && health.Nonce == state.HealthNonce &&
                            health.Pid == candidate.Id && health.StartTicks == state.CandidateStartTicks &&
                            health.Version == state.Version)
                        {
                            // Do not commit an immediately crashing process.
                            for (var sample = 0; sample < 10; sample++)
                            {
                                await Task.Delay(500, cancellation);
                                if (candidate.HasExited || !LocalAuthorizationAllowsRestart()) return false;
                            }
                            return true;
                        }
                    }
                    catch (JsonException) { } // Atomic writer may not have completed yet.
                    catch (IOException) { }
                }
                await Task.Delay(250, cancellation);
            }
            return false;
        }

        public async Task StopCandidate(UpdateJournal state, CancellationToken cancellation)
        {
            if (state.CandidatePid == null || state.CandidateStartTicks == null) return;
            try
            {
                using var child = Process.GetProcessById(state.CandidatePid.Value);
                if (child.StartTime.ToUniversalTime().Ticks != state.CandidateStartTicks ||
                    !string.Equals(child.MainModule?.FileName, AgentPath, StringComparison.OrdinalIgnoreCase)) return;
                if (!child.HasExited) child.Kill(entireProcessTree: false); // Only our failed replacement, never the old Agent.
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                deadline.CancelAfter(TimeSpan.FromSeconds(15));
                await child.WaitForExitAsync(deadline.Token);
            }
            catch (ArgumentException) { }
        }

        public async Task RestartRestoredAgent(CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            if (LocalAuthorizationAllowsRestart())
            {
                if (journal.Backups.Length > 0 && journal.Failure != "local_withdrawal")
                    ConfigFile.Write(Path.Combine(UpdateEnvironment.Root, "failed-version"), journal.Version);
                foreach (var existing in Process.GetProcessesByName("ConnectLive"))
                {
                    using (existing)
                    {
                        try
                        {
                            if (!existing.HasExited && string.Equals(existing.MainModule?.FileName,
                                AgentPath, StringComparison.OrdinalIgnoreCase)) return;
                        }
                        catch { return; } // Cannot establish absence: do not duplicate.
                    }
                }
                try
                {
                    if (!await CompanionAuthorization.MayRestartAsync("starting", cancellation)) return;
                }
                catch { return; } // Restored files stay ready; Watch can retry when authority is reachable.
                if (!LocalAuthorizationAllowsRestart()) return;
                using var process = Process.Start(new ProcessStartInfo(AgentPath, "/background")
                { UseShellExecute = false, WorkingDirectory = journal.InstallDirectory });
                if (process == null) throw new IOException("Restored Agent could not start");
            }
        }
    }
}
