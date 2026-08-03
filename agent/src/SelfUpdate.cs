using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// S14 — agent self-update (download → verify → swap → restart).
///
/// The agent is standalone: there is no watcher/updater service to swap the
/// binary for it, so the running process has to replace itself. Windows will
/// not let a running image be overwritten, but it WILL let it be renamed —
/// so the swap is:
///
///   1. Ask <c>/api/public/agent/release</c> for the newest published build
///      (device-token authed). 204/failure = nothing to do, ever.
///   2. Skip unless the manifest version is strictly newer than
///      <see cref="ApiClient.AgentVersion"/>.
///   3. Download to <c>%LOCALAPPDATA%\ConnectLive\update\</c>, accepting either
///      a bare .exe or a .zip containing ConnectLive.exe.
///   4. Verify SHA-256 when the manifest carries one. A manifest WITHOUT a
///      checksum is never installed — an unverified binary swap is a remote
///      code execution primitive, not an update.
///   5. Rename the live exe to <c>*.old</c>, move the new one into its place,
///      relaunch with <c>/background</c>, and exit the current process.
///
/// Safety rails, all deliberate:
///   - never runs while a session is live (checked by the caller);
///   - at most one attempt per version per process, and a 1 h floor between
///     checks, so a bad manifest cannot become a restart loop;
///   - every failure path is swallowed and logged — an update check must
///     never be able to take presence down.
/// </summary>
public static class SelfUpdate
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(1);
    private static readonly SemaphoreSlim Gate = new(1, 1);

    private static DateTime _lastCheckUtc = DateTime.MinValue;
    private static string? _attemptedVersion;

    /// <summary>Directory holding downloads and the retired *.old image.</summary>
    private static string UpdateDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ConnectLive", "update");

    /// <summary>True when the interval has elapsed since the last check.</summary>
    public static bool DueForCheck => DateTime.UtcNow - _lastCheckUtc >= CheckInterval;

    /// <summary>
    /// Check the manifest and, when a verified newer build exists, install it
    /// and restart. Returns true only when a restart has been launched (the
    /// caller should stop doing work; the process exits immediately after).
    /// </summary>
    public static async Task<bool> TryUpdateAsync(ApiClient api, CancellationToken ct)
    {
        if (!await Gate.WaitAsync(0, ct)) return false;
        try
        {
            _lastCheckUtc = DateTime.UtcNow;

            var manifest = await api.GetReleaseAsync("agent", "stable", ct);
            if (manifest?.Version is not { Length: > 0 } version) return false;
            if (string.IsNullOrWhiteSpace(manifest.DownloadUrl)) return false;

            var current = ApiClient.AgentVersion;
            if (!manifest.IsNewerThan(current)) return false;
            if (_attemptedVersion == version)
            {
                Log.Warn($"self-update: {version} already attempted this run, skipping");
                return false;
            }
            _attemptedVersion = version;

            if (string.IsNullOrWhiteSpace(manifest.Sha256))
            {
                Log.Warn($"self-update: release {version} has no sha256 — refusing unverified swap");
                return false;
            }

            var live = StartupRegistration.CurrentExePath();
            if (string.IsNullOrWhiteSpace(live) || !File.Exists(live))
            {
                Log.Warn("self-update: cannot resolve current exe path");
                return false;
            }

            Log.Info($"self-update: {current} -> {version} ({manifest.DownloadUrl})");

            var staged = await DownloadAndVerifyAsync(manifest.DownloadUrl!, manifest.Sha256!, version, ct);
            if (staged == null) return false;

            return SwapAndRestart(live!, staged, version);
        }
        catch (Exception ex)
        {
            Log.Warn($"self-update failed: {ex.Message}");
            return false;
        }
        finally { Gate.Release(); }
    }

    /// <summary>
    /// Download the artifact, verify its SHA-256, and return the path to a
    /// ready-to-install ConnectLive.exe (extracting it when the artifact is a
    /// zip). Null on any mismatch or failure.
    /// </summary>
    private static async Task<string?> DownloadAndVerifyAsync(
        string url, string expectedSha, string version, CancellationToken ct)
    {
        Directory.CreateDirectory(UpdateDir);
        var isZip = url.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);
        var artifact = Path.Combine(UpdateDir, isZip ? $"ConnectLive-{version}.zip" : $"ConnectLive-{version}.exe");

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            using (var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                if (!resp.IsSuccessStatusCode)
                {
                    Log.Warn($"self-update: download HTTP {(int)resp.StatusCode}");
                    return null;
                }
                await using var src = await resp.Content.ReadAsStreamAsync(ct);
                await using var dst = File.Create(artifact);
                await src.CopyToAsync(dst, ct);
            }

            var actual = Sha256File(artifact);
            if (!string.Equals(actual, expectedSha.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                Log.Warn($"self-update: sha256 mismatch (want {expectedSha}, got {actual}) — discarding");
                TryDelete(artifact);
                return null;
            }
            Log.Info($"self-update: sha256 verified for {version}");

            if (!isZip) return artifact;

            var extractDir = Path.Combine(UpdateDir, version);
            if (Directory.Exists(extractDir)) Directory.Delete(extractDir, true);
            ZipFile.ExtractToDirectory(artifact, extractDir);
            var exe = Directory
                .EnumerateFiles(extractDir, "ConnectLive.exe", SearchOption.AllDirectories)
                .FirstOrDefault();
            if (exe == null)
            {
                Log.Warn("self-update: zip contains no ConnectLive.exe");
                return null;
            }
            return exe;
        }
        catch (Exception ex)
        {
            Log.Warn($"self-update: download/verify failed: {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// Rename-then-replace the live image and relaunch. Any failure before the
    /// relaunch is rolled back so the machine is never left without an agent.
    /// </summary>
    private static bool SwapAndRestart(string live, string staged, string version)
    {
        var retired = Path.Combine(UpdateDir, $"ConnectLive-{ApiClient.AgentVersion}.old");
        TryDelete(retired);
        try
        {
            // A running image can't be overwritten, but it can be renamed.
            File.Move(live, retired);
            try
            {
                File.Copy(staged, live, overwrite: true);
            }
            catch (Exception ex)
            {
                // Put the old binary back — a half-swapped install is worse
                // than a missed update.
                try { File.Move(retired, live); } catch { }
                Log.Warn($"self-update: install failed, rolled back: {ex.Message}");
                return false;
            }

            // Re-assert startup registration against the new image, then hand
            // over. /background keeps the relaunch silent (no splash).
            try { StartupRegistration.EnsureRegistered(); } catch { }

            Process.Start(new ProcessStartInfo
            {
                FileName = live,
                Arguments = "/background",
                UseShellExecute = false,
                CreateNoWindow = true,
            });

            Log.Info($"self-update: installed {version}, restarting");
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"self-update: swap failed: {ex.Message}");
            return false;
        }
    }

    private static string Sha256File(string path)
    {
        using var sha = SHA256.Create();
        using var fs = File.OpenRead(path);
        return Convert.ToHexString(sha.ComputeHash(fs)).ToLowerInvariant();
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
}
