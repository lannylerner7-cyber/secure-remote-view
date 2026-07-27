using System;
using System.IO;
using Microsoft.Win32;

namespace ConnectLive.Agent;

/// <summary>
/// Deployment key resolver — shared by Agent and Watcher.
///
/// Resolution order (first non-empty wins):
///   0. HKLM\Software\Policies\ConnectLive\DeploymentKey  (GPO / Intune / Jamf policy)
///   1. %ProgramData%\ConnectLive\deployment.key          (ops-rotatable, no rebuild)
///   2. AGENT_DEPLOYMENT_KEY environment variable         (dev / CI)
///   3. EmbeddedKey constant                              (baked at build time)
///
/// The value is a bearer secret — used ONCE per device to call
/// POST /api/public/agent/enroll. After enrollment the device gets its own
/// per-device token, so rotating this key never breaks existing installs.
///
/// NEVER commit the real key to source control.
/// </summary>
public static class DeploymentKey
{
    /// <summary>Optional compile-time embed. Overwrite before `dotnet publish`.</summary>
    public const string EmbeddedKey = "";

    private const string PolicyRegPath = @"Software\Policies\ConnectLive";
    private const string PolicyRegName = "DeploymentKey";

    private static readonly string KeyFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "ConnectLive", "deployment.key");

    public static string? Resolve()
    {
        // 0. HKLM policy (managed by GPO ADMX / Intune / Jamf configuration profile)
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(PolicyRegPath, writable: false);
            var v = key?.GetValue(PolicyRegName) as string;
            if (!string.IsNullOrWhiteSpace(v)) return v.Trim();
        }
        catch { /* fall through */ }

        // 1. %ProgramData%\ConnectLive\deployment.key (MSI CustomAction / manual ops drop)
        try
        {
            if (File.Exists(KeyFile))
            {
                var v = File.ReadAllText(KeyFile).Trim();
                if (!string.IsNullOrEmpty(v)) return v;
            }
        }
        catch { /* fall through */ }

        // 2. Environment variable (dev / CI)
        var env = Environment.GetEnvironmentVariable("AGENT_DEPLOYMENT_KEY");
        if (!string.IsNullOrWhiteSpace(env)) return env.Trim();

        // 3. Compile-time embed
        if (!string.IsNullOrWhiteSpace(EmbeddedKey)) return EmbeddedKey.Trim();
        return null;
    }
}
