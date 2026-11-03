using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ConnectLive.Updates;

internal static class UpdateTests
{
    internal static async Task RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "connectlive-update-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var publisher = RSA.Create(3072);
        var publicKey = publisher.ExportSubjectPublicKeyInfoPem();
        int checks = 0;
        void Check(bool value, string name)
        {
            if (!value) throw new InvalidOperationException("Update test failed: " + name);
            checks++;
        }
        void Reject(Action action, string name)
        {
            try { action(); }
            catch (Exception ex) when (ex is InvalidDataException or CryptographicException or IOException)
            { checks++; return; }
            throw new InvalidOperationException("Update accepted invalid input: " + name);
        }
        string Bundle(string name, bool tamperPayload = false, bool extraEntry = false)
        {
            var bytes = UpdatePackage.RuntimeFiles.ToDictionary(n => n, n => Encoding.UTF8.GetBytes("new-" + n));
            var manifest = new PackageManifest(1, "connectlive-agent", "win-x64", "1.10.1",
                bytes.Select(p => new PackageFile(p.Key, p.Value.Length,
                    Convert.ToHexString(SHA256.HashData(p.Value)).ToLowerInvariant())).ToArray());
            var data = JsonSerializer.SerializeToUtf8Bytes(manifest, UpdatePackage.Json);
            var path = Path.Combine(root, name + ".zip");
            using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
            foreach (var file in bytes)
            {
                using var stream = zip.CreateEntry(file.Key).Open();
                var payload = file.Value.ToArray();
                if (tamperPayload && file.Key == "ConnectLive.exe") payload[0] ^= 1;
                stream.Write(payload);
            }
            using (var stream = zip.CreateEntry("manifest.json").Open()) stream.Write(data);
            using (var stream = zip.CreateEntry("manifest.sig").Open())
                stream.Write(publisher.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pss));
            if (extraEntry) { using var stream = zip.CreateEntry("../escape.exe").Open(); stream.WriteByte(1); }
            return path;
        }
        try
        {
            Check(UpdatePackage.IsZipUrl("https://example.test/agent.ZIP?signature=redacted"), "URL path, not query suffix");
            Check(!UpdatePackage.IsZipUrl("http://example.test/agent.zip"), "HTTPS required");
            Check(!UpdatePackage.IsZipUrl("https://name:password@example.test/agent.zip"), "URL userinfo rejected");
            Check(!UpdatePackage.IsZipUrl("https://example.test/agent.zip#fragment"), "URL fragment rejected");
            var zip = Bundle("valid");
            var verified = UpdatePackage.VerifyAndExtract(zip, Path.Combine(root, "verified"), publicKey,
                "1.10.1", UpdatePackage.HashFile(zip));
            Check(verified.Manifest.Files.Length == 3, "all runtime companions authenticated");
            using var otherPublisher = RSA.Create(3072);
            Reject(() => UpdatePackage.VerifyAndExtract(zip, Path.Combine(root, "wrong-key"),
                otherPublisher.ExportSubjectPublicKeyInfoPem(), "1.10.1", UpdatePackage.HashFile(zip)), "wrong publisher");
            var changed = Bundle("changed", tamperPayload: true);
            Reject(() => UpdatePackage.VerifyAndExtract(changed, Path.Combine(root, "changed-out"),
                publicKey, "1.10.1", UpdatePackage.HashFile(changed)), "rehashed outer ZIP cannot conceal changed payload");
            var traversal = Bundle("traversal", extraEntry: true);
            Reject(() => UpdatePackage.VerifyAndExtract(traversal, Path.Combine(root, "traversal-out"),
                publicKey, "1.10.1", UpdatePackage.HashFile(traversal)), "unsigned extra/path traversal");
            Reject(() => UpdatePackage.VerifyAndExtract(zip, Path.Combine(root, "wrong-version"),
                publicKey, "1.10.2", UpdatePackage.HashFile(zip)), "signed version binding");
            Reject(() => UpdatePackage.VerifyAndExtract(zip, Path.Combine(root, "wrong-sha"),
                publicKey, "1.10.1", new string('0', 64)), "archive digest");
            Check(!File.Exists(Path.Combine(root, "escape.exe")), "archive did not escape staging");

            async Task Exercise(string name, bool health, bool copyFailure, bool withdraw)
            {
                var job = Path.Combine(root, name);
                var install = Path.Combine(job, "install");
                Directory.CreateDirectory(install);
                // Old installs may be missing companions: rollback must remove
                // new files that did not exist, not leave a mixed installation.
                File.WriteAllText(Path.Combine(install, "ConnectLive.exe"), "old-agent");
                var state = new UpdateJournal { InstallDirectory = install, Version = "1.10.1" };
                state.Save(Path.Combine(job, "journal.json"));
                var runtime = new FakeRuntime { Healthy = health, WithdrawAtLaunch = withdraw };
                var writes = 0;
                var transaction = new UpdateTransaction(job, state, runtime, (source, destination) =>
                {
                    Check(runtime.OldExited, name + ": no replacement before old process exit");
                    if (copyFailure && ++writes == 2) throw new IOException("simulated copy failure");
                    UpdateTransaction.AtomicReplace(source, destination);
                });
                var applied = await transaction.Apply(verified, CancellationToken.None);
                Check(applied == (health && !copyFailure && !withdraw), name + ": correct outcome");
                if (!applied)
                {
                    Check(File.ReadAllText(Path.Combine(install, "ConnectLive.exe")) == "old-agent", name + ": original restored");
                    Check(!File.Exists(Path.Combine(install, "ConnectLiveWatch.exe")), name + ": new companion removed");
                    Check(runtime.Restarts == (withdraw ? 0 : 1), name + ": withdrawal overrides restart");
                    Check(state.Phase == "rolled_back", name + ": durable rollback phase");
                }
                else Check(state.Phase == "committed" && runtime.Restarts == 0, name + ": committed only after health");
                Check(UpdateJournal.Read(Path.Combine(job, "journal.json")).Phase == state.Phase, name + ": journal roundtrip");
            }
            await Exercise("healthy", health: true, copyFailure: false, withdraw: false);
            await Exercise("failed-copy", health: true, copyFailure: true, withdraw: false);
            await Exercise("failed-health", health: false, copyFailure: false, withdraw: false);
            await Exercise("withdrawal", health: true, copyFailure: false, withdraw: true);

            var recovery = Path.Combine(root, "interrupted");
            var live = Path.Combine(recovery, "install");
            var backup = Path.Combine(recovery, "backup");
            Directory.CreateDirectory(live); Directory.CreateDirectory(backup);
            var inventory = UpdatePackage.RuntimeFiles.Select(n =>
            {
                File.WriteAllText(Path.Combine(backup, n), "old-" + n);
                File.WriteAllText(Path.Combine(live, n), "partial-new-" + n);
                return new BackupFile(n, true, UpdatePackage.HashFile(Path.Combine(backup, n)));
            }).ToArray();
            var interrupted = new UpdateJournal
            { InstallDirectory = live, Version = "1.10.1", Phase = "installing", Backups = inventory };
            interrupted.Save(Path.Combine(recovery, "journal.json"));
            var recoveredRuntime = new FakeRuntime();
            await new UpdateTransaction(recovery, UpdateJournal.Read(Path.Combine(recovery, "journal.json")),
                recoveredRuntime).Recover(CancellationToken.None);
            Check(UpdatePackage.RuntimeFiles.All(n => File.ReadAllText(Path.Combine(live, n)) == "old-" + n),
                "interrupted transaction restores the complete inventory");
            Check(recoveredRuntime.Restarts == 1, "recovery restarts only after restore");
            var mutexName = "ConnectLive-test-" + Guid.NewGuid().ToString("N");
            using var existingHandle = new Mutex(false, mutexName);
            using var agentHandle = new Mutex(false, mutexName, out var created);
            Check(!created && agentHandle.WaitOne(0), "existing unowned mutex is acquirable");
            agentHandle.ReleaseMutex();
            Console.WriteLine($"{checks} signed-package / transaction checks passed (managed runtime model; NOT Windows installation evidence)");
        }
        finally { Directory.Delete(root, true); }
    }

    private sealed class FakeRuntime : IUpdateRuntime
    {
        internal bool Healthy = true, WithdrawAtLaunch, Allowed = true, OldExited;
        internal int Restarts;
        public bool LocalAuthorizationAllowsRestart() => Allowed;
        public Task WaitForOldProcessExit(CancellationToken cancellation) { OldExited = true; return Task.CompletedTask; }
        public Task<bool> LaunchAndConfirmHealth(UpdateJournal journal, CancellationToken cancellation)
        {
            if (!OldExited) throw new InvalidOperationException("Replacement launched before old exit");
            if (WithdrawAtLaunch) Allowed = false;
            return Task.FromResult(Healthy);
        }
        public Task StopCandidate(UpdateJournal journal, CancellationToken cancellation) => Task.CompletedTask;
        public Task RestartRestoredAgent(CancellationToken cancellation) { Restarts++; return Task.CompletedTask; }
    }
}
