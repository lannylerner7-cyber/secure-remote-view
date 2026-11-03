namespace ConnectLive.Updates;

public interface IUpdateRuntime
{
    bool LocalAuthorizationAllowsRestart();
    Task WaitForOldProcessExit(CancellationToken cancellation);
    Task<bool> LaunchAndConfirmHealth(UpdateJournal journal, CancellationToken cancellation);
    Task StopCandidate(UpdateJournal journal, CancellationToken cancellation);
    Task RestartRestoredAgent(CancellationToken cancellation);
}

/// <summary>
/// File changes happen only after the old process exits. A durable full backup
/// precedes any replacement. Recovery restores all files, including a move that
/// completed immediately before a process crash.
/// </summary>
public sealed class UpdateTransaction(
    string jobDirectory, UpdateJournal journal, IUpdateRuntime runtime,
    Action<string, string>? replaceFile = null)
{
    private string JournalPath => Path.Combine(jobDirectory, "journal.json");
    private string BackupDirectory => Path.Combine(jobDirectory, "backup");
    private readonly Action<string, string> _replace = replaceFile ?? AtomicReplace;

    public async Task<bool> Apply(VerifiedPackage package, CancellationToken ct)
    {
        try
        {
            if (!runtime.LocalAuthorizationAllowsRestart()) throw new OperationCanceledException("local_withdrawal");
            journal.Phase = "waiting_for_exit";
            journal.Save(JournalPath);
            await runtime.WaitForOldProcessExit(ct);
            if (!runtime.LocalAuthorizationAllowsRestart()) throw new OperationCanceledException("local_withdrawal");
            if (package.Manifest.Version != journal.Version) throw new InvalidDataException("Version mismatch");
            Directory.CreateDirectory(BackupDirectory);
            var backups = new List<BackupFile>();
            foreach (var name in UpdatePackage.RuntimeFiles)
            {
                var live = Path.Combine(journal.InstallDirectory, name);
                var exists = File.Exists(live);
                if (exists) AtomicReplace(live, Path.Combine(BackupDirectory, name));
                backups.Add(new(name, exists, exists ? UpdatePackage.HashFile(Path.Combine(BackupDirectory, name)) : null));
            }
            journal.Backups = backups.ToArray();
            journal.Phase = "installing";
            journal.Save(JournalPath);
            foreach (var file in package.Manifest.Files)
            {
                if (!runtime.LocalAuthorizationAllowsRestart()) throw new OperationCanceledException("local_withdrawal");
                _replace(Path.Combine(package.Directory, file.Path), Path.Combine(journal.InstallDirectory, file.Path));
                if (!UpdatePackage.HashFile(Path.Combine(journal.InstallDirectory, file.Path))
                    .Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Installed file differs from signed manifest");
            }
            journal.Phase = "awaiting_health";
            journal.Save(JournalPath);
            if (!runtime.LocalAuthorizationAllowsRestart() || !await runtime.LaunchAndConfirmHealth(journal, ct))
                throw new IOException("launch_health_failed");
            if (!runtime.LocalAuthorizationAllowsRestart()) throw new OperationCanceledException("local_withdrawal");
            journal.Phase = "committed";
            try { journal.Save(JournalPath); }
            catch { journal.Phase = "awaiting_health"; throw; }
            return true;
        }
        catch
        {
            journal.Failure = runtime.LocalAuthorizationAllowsRestart() ? "update_failed" : "local_withdrawal";
            await Recover(CancellationToken.None);
            return false;
        }
    }

    public async Task Recover(CancellationToken ct)
    {
        if (journal.IsTerminal) return;
        await runtime.StopCandidate(journal, ct);
        if (journal.Backups.Length == 0)
        {
            // No live files were changed. Do not wait on or terminate a parent
            // that elected not to hand off.
            if (journal.Phase is not ("prepared" or "waiting_for_exit"))
                throw new InvalidDataException("Update state has no rollback inventory");
            journal.Phase = "aborted";
            journal.Save(JournalPath);
            if (runtime.LocalAuthorizationAllowsRestart()) await runtime.RestartRestoredAgent(ct);
            return;
        }
        // Never replace files while the original process still owns them.
        await runtime.WaitForOldProcessExit(ct);
        if (journal.Backups.Length > 0)
        {
            if (journal.Backups.Length != UpdatePackage.RuntimeFiles.Length ||
                journal.Backups.Select(b => b.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != UpdatePackage.RuntimeFiles.Length ||
                journal.Backups.Any(b => !UpdatePackage.RuntimeFiles.Contains(b.Name, StringComparer.Ordinal)))
                throw new InvalidDataException("Invalid rollback inventory");
            foreach (var file in journal.Backups.Where(b => b.Existed))
                if (!File.Exists(Path.Combine(BackupDirectory, file.Name)) ||
                    !UpdatePackage.HashFile(Path.Combine(BackupDirectory, file.Name))
                        .Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Rollback backup is missing or corrupt");
            journal.Phase = "rolling_back";
            journal.Save(JournalPath);
            foreach (var file in journal.Backups)
            {
                var live = Path.Combine(journal.InstallDirectory, file.Name);
                if (file.Existed) AtomicReplace(Path.Combine(BackupDirectory, file.Name), live);
                else if (File.Exists(live)) File.Delete(live);
            }
        }
        journal.Phase = journal.Backups.Length > 0 ? "rolled_back" : "aborted";
        journal.Save(JournalPath);
        if (runtime.LocalAuthorizationAllowsRestart()) await runtime.RestartRestoredAgent(ct);
    }

    public static void AtomicReplace(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = destination + ".update-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var input = File.OpenRead(source))
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                input.CopyTo(output);
                output.Flush(true);
            }
            // A just-exiting Watch or antivirus scanner can briefly retain an
            // image handle. Retry boundedly; never bypass ACLs or kill it.
            for (var attempt = 0; ; attempt++)
            {
                try { DurableFile.Replace(temporary, destination); break; }
                catch (IOException) when (OperatingSystem.IsWindows() && attempt < 19)
                { Thread.Sleep(100); }
            }
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
