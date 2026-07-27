using System;
using System.IO;

namespace ConnectLive.Agent;

/// <summary>
/// Deployment key resolver — shared by Agent and Watcher.
///
/// Resolution order:
///   1. %ProgramData%\ConnectLive\deployment.key   (ops-rotatable, no rebuild)
///   2. AGENT_DEPLOYMENT_KEY environment variable  (dev / CI)
///   3. EmbeddedKey constant                       (baked at build time)
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

    private static readonly string KeyFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "ConnectLive", "deployment.key");

    public static string? Resolve()
    {
        try
        {
            if (File.Exists(KeyFile))
            {
                var v = File.ReadAllText(KeyFile).Trim();
                if (!string.IsNullOrEmpty(v)) return v;
            }
        }
        catch { /* fall through */ }

        var env = Environment.GetEnvironmentVariable("AGENT_DEPLOYMENT_KEY");
        if (!string.IsNullOrWhiteSpace(env)) return env.Trim();

        if (!string.IsNullOrWhiteSpace(EmbeddedKey)) return EmbeddedKey.Trim();
        return null;
    }
}
