using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Watch;

/// <summary>
/// One-minute companion task. If ConnectLive.exe is not running, POST a
/// "stopped" beacon so the admin panel can flip the device to a red
/// "stopped" chip, then relaunch the agent in /background.
///
/// Runs under the same user as ConnectLive.exe (SCHTASKS /RL LIMITED),
/// which is why the DPAPI store below opens with the same LocalMachine
/// scope the agent uses.
///
/// Exits promptly — this is a scheduled task, not a service.
/// </summary>
internal static class Program
{
    private const string AgentProcessName = "ConnectLive";
    private const string AgentExeName = "ConnectLive.exe";
    private const string BeaconRoute = "/api/public/agent/beacon";
    private const string DefaultApiBaseUrl = "https://connectliveagent.com";

    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ConnectLive");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");
    private static readonly string DevicePath = Path.Combine(ConfigDir, "device.dat");

    public static async Task<int> Main()
    {
        if (ConnectLive.Agent.LocalAccessState.IsDisabled()) return 0;
        try
        {
            if (IsAgentRunning()) return 0;

            var creds = LoadCreds();
            if (creds is null)
            {
                // Nothing enrolled yet — the agent has never completed a
                // first run on this profile. No one to beacon as; the
                // scheduled task will pick it up on the next tick once the
                // user launches the agent.
                return 0;
            }

            var apiBase = LoadApiBaseUrl();
            await SendBeaconAsync(apiBase, creds.Value.DeviceId, creds.Value.DeviceToken, "stopped");
            TryRelaunchAgent();
            return 0;
        }
        catch
        {
            // Best-effort. Never surface UI, never crash the task.
            return 0;
        }
    }

    private static bool IsAgentRunning()
    {
        try
        {
            var mine = Environment.ProcessId;
            foreach (var p in Process.GetProcessesByName(AgentProcessName))
            {
                using (p)
                {
                    if (p.Id != mine) return true;
                }
            }
            return false;
        }
        catch { return true; } // fail closed: assume alive rather than double-post
    }

    private static (string DeviceId, string DeviceToken)? LoadCreds()
    {
        try
        {
            if (!File.Exists(DevicePath)) return null;
            var enc = File.ReadAllBytes(DevicePath);
            var dec = ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine);
            var creds = JsonSerializer.Deserialize<StoredCreds>(dec);
            if (creds is null || string.IsNullOrWhiteSpace(creds.DeviceId) || string.IsNullOrWhiteSpace(creds.DeviceToken))
                return null;
            return (creds.DeviceId, creds.DeviceToken);
        }
        catch { return null; }
    }

    private static string LoadApiBaseUrl()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                using var s = File.OpenRead(ConfigPath);
                var cfg = JsonSerializer.Deserialize<AgentConfig>(s);
                if (!string.IsNullOrWhiteSpace(cfg?.ApiBaseUrl))
                    return cfg!.ApiBaseUrl!.TrimEnd('/');
            }
        }
        catch { }
        return DefaultApiBaseUrl;
    }

    private static async Task SendBeaconAsync(string apiBase, string deviceId, string deviceToken, string reason)
    {
        if (ConnectLive.Agent.LocalAccessState.IsDisabled()) return;
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var url = apiBase.TrimEnd('/') + BeaconRoute;
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Add("X-Device-Id", deviceId);
        req.Headers.Add("X-Device-Token", deviceToken);
        var body = JsonSerializer.Serialize(new { reason });
        req.Content = new StringContent(body, Encoding.UTF8);
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        try { using var _ = await http.SendAsync(req); } catch { }
    }

    private static void TryRelaunchAgent()
    {
        if (ConnectLive.Agent.LocalAccessState.IsDisabled()) return;
        try
        {
            var here = AppContext.BaseDirectory;
            var exe = Path.Combine(here, AgentExeName);
            if (!File.Exists(exe)) return;
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = "/background",
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = here,
            };
            using var _ = Process.Start(psi);
        }
        catch { }
    }

    private sealed record StoredCreds(string DeviceId, string DeviceToken);

    private sealed class AgentConfig
    {
        [JsonPropertyName("apiBaseUrl")]
        public string? ApiBaseUrl { get; set; }
    }
}
