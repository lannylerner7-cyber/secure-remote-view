using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using ConnectLive.Updates;

namespace ConnectLive.Agent;

/// <summary>
/// Downloads and authenticates in the background. The heartbeat loop commits
/// only while idle; a separate non-elevated worker waits for this process to
/// exit before touching installed files. No unsigned or checksum-only update.
/// </summary>
public static class SelfUpdate
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static DateTime _lastCheckUtc = DateTime.MinValue;
    private static Task? _preparing;
    private static string? _readyJob;
    private static string? _attemptedVersion;
    private static Process? _worker;
    public static event Action? WorkAvailable;
    private static string _state = "idle";
    public static string State
    {
        get => _state;
        private set
        {
            if (_state == value) return;
            _state = value;
            Log.Info("signed update status: " + value);
        }
    }
    public static bool DueForCheck => _readyJob != null ||
        (_preparing?.IsCompleted != false && DateTime.UtcNow - _lastCheckUtc >= TimeSpan.FromHours(1));

    public static async Task<bool> TryUpdateAsync(ApiClient api, CancellationToken ct)
    {
        if (!await Gate.WaitAsync(0, ct)) return false;
        try
        {
            if (!StartupConsent.IsAllowed()) { State = "local-opt-in-required"; return false; }
            if (!UpdateEnvironment.IsUserInstall(AppContext.BaseDirectory) || UpdateEnvironment.IsElevated())
            { State = "administrator-managed"; return false; }
            if (UpdatePackage.InstalledPublisherKey() == null)
            { State = "publisher-key-required"; return false; }
            if (_readyJob != null)
            {
                var id = _readyJob;
                var directory = UpdateEnvironment.JobPath(id);
                if (_worker != null)
                {
                    if (_worker.HasExited)
                    {
                        _worker.Dispose(); _worker = null; _readyJob = null;
                        _attemptedVersion = null;
                        _lastCheckUtc = DateTime.UtcNow;
                        State = "worker-start-failed";
                        return false;
                    }
                    if (File.Exists(Path.Combine(directory, "worker-ready")) &&
                        File.ReadAllText(Path.Combine(directory, "worker-ready")) == id)
                    {
                        // Written only by the idle heartbeat path. A parent
                        // crash before this point must recover, not install.
                        var journal = UpdateJournal.Read(Path.Combine(directory, "journal.json"));
                        // Persist before exit, including failures before backup
                        // creation. Otherwise restarting the old build can
                        // immediately repeat the same failed update forever.
                        ConfigFile.Write(Path.Combine(UpdateEnvironment.Root, "attempted-version"), journal.Version);
                        ConfigFile.Write(Path.Combine(directory, "commit"), id);
                        State = "handoff";
                        Log.Info("signed update worker ready; Agent exiting before replacement");
                        return true;
                    }
                    return false;
                }
                if (UpdateEnvironment.Pending()) return false;
                ConfigFile.Write(UpdateEnvironment.ActivePointer, id);
                var start = new ProcessStartInfo(Path.Combine(directory, "runner", "ConnectLiveUpdate.exe"))
                { UseShellExecute = false, CreateNoWindow = true };
                start.ArgumentList.Add("--apply"); start.ArgumentList.Add(id);
                _worker = Process.Start(start) ?? throw new IOException("Update worker did not start");
                var pid = _worker.Id;
                State = "worker-verifying";
                _ = Task.Run(async () =>
                {
                    try
                    {
                        using var observer = Process.GetProcessById(pid);
                        var wait = Stopwatch.StartNew();
                        while (!observer.HasExited && wait.Elapsed < TimeSpan.FromSeconds(90))
                        {
                            if (File.Exists(Path.Combine(directory, "worker-ready"))) break;
                            await Task.Delay(100, ct);
                        }
                        WorkAvailable?.Invoke();
                    }
                    catch (OperationCanceledException) { }
                    catch { WorkAvailable?.Invoke(); }
                }, ct);
                // Keep heartbeats, invitations and local withdrawal responsive
                // while the worker validates/extracts the signed bundle.
                return false;
            }
            if (_preparing?.IsCompleted == false || !DueForCheck) return false;
            _lastCheckUtc = DateTime.UtcNow;
            _preparing = Task.Run(() => Prepare(api, ct), ct);
            return false;
        }
        catch (OperationCanceledException) { return false; }
        catch (Exception ex)
        {
            State = "update-failed";
            Log.Warn($"signed update could not proceed ({ex.GetType().Name}); current installation retained");
            return false;
        }
        finally { Gate.Release(); }
    }

    private static async Task Prepare(ApiClient api, CancellationToken ct)
    {
        string? jobDirectory = null;
        try
        {
            State = "checking";
            var release = await api.GetReleaseAsync("agent", "stable-update", ct);
            if (release == null || !release.IsNewerThan(ApiClient.AgentVersion) ||
                string.IsNullOrWhiteSpace(release.Version) || string.IsNullOrWhiteSpace(release.DownloadUrl) ||
                string.IsNullOrWhiteSpace(release.Sha256)) { State = "current"; return; }
            var version = release.Version;
            UpdatePackage.ValidateVersion(version);
            if (_attemptedVersion == version) return;
            Directory.CreateDirectory(UpdateEnvironment.Root);
            var failedVersion = Path.Combine(UpdateEnvironment.Root, "attempted-version");
            if (File.Exists(failedVersion) && File.ReadAllText(failedVersion).Trim() == version)
            { State = "failed-release-held"; return; }
            _attemptedVersion = version;
            if (!UpdatePackage.IsZipUrl(release.DownloadUrl) ||
                !new Uri(release.DownloadUrl).GetLeftPart(UriPartial.Authority)
                    .Equals(LocalGrant.OriginOf(api.ApiBaseUrl), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Update ZIP must use the configured gateway HTTPS origin");
            using var parent = Process.GetCurrentProcess();
            var journal = new UpdateJournal
            {
                InstallDirectory = AppContext.BaseDirectory, Version = version,
                ArchiveSha256 = release.Sha256, ParentPid = parent.Id,
                ParentStartTicks = parent.StartTime.ToUniversalTime().Ticks,
            };
            jobDirectory = UpdateEnvironment.JobPath(journal.Id);
            Directory.CreateDirectory(jobDirectory);
            var archive = Path.Combine(jobDirectory, "package.zip");
            State = "downloading";
            using (var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
                   { Timeout = TimeSpan.FromMinutes(10) })
            using (var response = await http.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > UpdatePackage.MaxArchiveBytes)
                    throw new InvalidDataException("Update download exceeds size limit");
                await using var input = await response.Content.ReadAsStreamAsync(ct);
                await using var output = new FileStream(archive, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                var buffer = new byte[81920];
                long total = 0;
                int count;
                while ((count = await input.ReadAsync(buffer, ct)) != 0)
                {
                    if (!StartupConsent.IsAllowed()) throw new OperationCanceledException("Local startup authorization withdrawn");
                    total += count;
                    if (total > UpdatePackage.MaxArchiveBytes) throw new InvalidDataException("Update download exceeds size limit");
                    await output.WriteAsync(buffer.AsMemory(0, count), ct);
                }
                output.Flush(true);
            }
            State = "verifying";
            UpdatePackage.VerifyAndExtract(archive, Path.Combine(jobDirectory, "stage"),
                UpdatePackage.InstalledPublisherKey()!, version, release.Sha256);
            var runnerDirectory = Path.Combine(jobDirectory, "runner");
            Directory.CreateDirectory(runnerDirectory);
            var runner = Path.Combine(runnerDirectory, "ConnectLiveUpdate.exe");
            File.Copy(Path.Combine(AppContext.BaseDirectory, "ConnectLiveUpdate.exe"), runner);
            journal.RunnerSha256 = UpdatePackage.HashFile(runner);
            journal.Save(Path.Combine(jobDirectory, "journal.json"));
            ct.ThrowIfCancellationRequested();
            if (!StartupConsent.IsAllowed()) throw new OperationCanceledException();
            _readyJob = journal.Id;
            State = "staged-waiting-for-idle";
            WorkAvailable?.Invoke();
        }
        catch (Exception ex)
        {
            State = ex is OperationCanceledException ? "cancelled" : "verification-failed";
            Log.Warn($"signed update staging stopped ({ex.GetType().Name}); no installed files changed");
            if (jobDirectory != null)
                try
                {
                    var activeId = File.Exists(UpdateEnvironment.ActivePointer)
                        ? File.ReadAllText(UpdateEnvironment.ActivePointer).Trim() : null;
                    if (activeId != Path.GetFileName(jobDirectory)) Directory.Delete(jobDirectory, true);
                }
                catch { } // Preserve ambiguous state for recovery rather than delete it.
        }
    }
}
