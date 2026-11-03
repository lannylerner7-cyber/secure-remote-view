using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text.Json;
using ConnectLive.Updates;

namespace ConnectLive.Agent;

internal static class UpdateEnvironment
{
    internal const string MutexName = @"Local\ConnectLive.AuthorizedUpdate";
    internal static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ConnectLive", "updates");
    internal static string UserInstall => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs", "ConnectLive");
    internal static string ActivePointer => Path.Combine(Root, "active-update");
    private static UpdateJournal? _candidate;
    private static bool _reportedHealthy;

    internal static string JobPath(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("Invalid update job ID");
        return Path.Combine(Root, id);
    }

    internal static bool IsUserInstall(string path) =>
        string.Equals(Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar),
            Path.GetFullPath(UserInstall).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);

    internal static bool IsElevated() =>
        new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    internal static UpdateJournal? Active()
    {
        if (!File.Exists(ActivePointer)) return null;
        var id = File.ReadAllText(ActivePointer).Trim();
        var journal = UpdateJournal.Read(Path.Combine(JobPath(id), "journal.json"));
        if (journal.Id != id || !IsUserInstall(journal.InstallDirectory))
            throw new InvalidDataException("Update target is not the authorized per-user installation");
        return journal.IsTerminal ? null : journal;
    }

    internal static bool Pending()
    {
        try { return Active() != null; }
        catch { return true; } // Corrupt state must not start a possibly partial install.
    }

    internal static bool AllowCandidate(string[] args, string version)
    {
        try
        {
            var position = Array.IndexOf(args, "/update-job");
            var noncePosition = Array.IndexOf(args, "/update-health");
            if (position < 0 || position + 1 >= args.Length || noncePosition < 0 || noncePosition + 1 >= args.Length)
                return false;
            var journal = Active();
            if (journal == null || journal.Phase != "awaiting_health" ||
                journal.Id != args[position + 1] || journal.HealthNonce != args[noncePosition + 1] ||
                journal.Version != version || !StartupConsent.IsAllowed() ||
                !IsUserInstall(AppContext.BaseDirectory)) return false;
            _candidate = journal;
            return true;
        }
        catch { return false; }
    }

    internal static void ReportHealthy(string version)
    {
        // Called only after an authenticated heartbeat matches the stored grant.
        if (_candidate == null || _reportedHealthy || !StartupConsent.IsAllowed() || version != _candidate.Version) return;
        using var process = Process.GetCurrentProcess();
        var value = JsonSerializer.Serialize(new HealthReceipt(_candidate.Id, _candidate.HealthNonce,
            process.Id, process.StartTime.ToUniversalTime().Ticks, version));
        ConfigFile.Write(Path.Combine(JobPath(_candidate.Id), "health.json"), value);
        _reportedHealthy = true;
    }

    internal static bool StartRecovery(bool foregroundRepair = false)
    {
        if ((!foregroundRepair && !StartupConsent.IsAllowed()) || IsElevated()) return false;
        try
        {
            var journal = Active();
            if (journal == null) return false;
            using var gate = new System.Threading.Mutex(false, MutexName);
            bool acquired;
            try { acquired = gate.WaitOne(0); }
            catch (System.Threading.AbandonedMutexException) { acquired = true; }
            if (!acquired) return true;
            gate.ReleaseMutex();
            var runner = Path.Combine(JobPath(journal.Id), "runner", "ConnectLiveUpdate.exe");
            if (!UpdatePackage.HashFile(runner).Equals(journal.RunnerSha256, StringComparison.OrdinalIgnoreCase)) return false;
            var start = new ProcessStartInfo(runner) { UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add("--recover");
            start.ArgumentList.Add(journal.Id);
            using var process = Process.Start(start);
            return process != null;
        }
        catch { return false; }
    }

    internal sealed record HealthReceipt(string JobId, string Nonce, int Pid, long StartTicks, string Version);
}
