using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace ConnectLive.Agent;

/// <summary>Non-secret process identity and acknowledged heartbeat, shared with Watch.</summary>
internal static class AgentProcessState
{
    internal sealed record Snapshot(string Instance, int ProcessId, DateTime StartedAt,
        string AuthorizationId, DateTime? HealthyAt);
    internal static readonly string Instance = Guid.NewGuid().ToString("D");
    private static readonly object Gate = new();
    private static string FileName => Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData), "ConnectLive", "agent-process.json");
    private static bool _announced;

    internal static void Announce(string authorizationId)
    {
        lock (Gate)
        {
            if (_announced) return;
            Write(new(Instance, Environment.ProcessId, Process.GetCurrentProcess().StartTime.ToUniversalTime(),
                authorizationId, null));
            _announced = true;
        }
    }

    internal static void Healthy(string authorizationId)
    {
        lock (Gate)
            Write(new(Instance, Environment.ProcessId, Process.GetCurrentProcess().StartTime.ToUniversalTime(),
                authorizationId, DateTime.UtcNow));
    }

    internal static Snapshot? Read()
    {
        try
        {
            if (new FileInfo(FileName).Length > 4096) return null;
            var state = JsonSerializer.Deserialize<Snapshot>(File.ReadAllText(FileName));
            return state != null && Guid.TryParse(state.Instance, out _) &&
                Guid.TryParse(state.AuthorizationId, out _) && state.ProcessId > 0 ? state : null;
        }
        catch { return null; }
    }

    internal static bool IsHealthy(Snapshot? state, Process process, string authorizationId)
    {
        if (state?.HealthyAt is not DateTime seen || state.AuthorizationId != authorizationId ||
            state.ProcessId != process.Id || process.HasExited) return false;
        var elapsed = DateTime.UtcNow - seen;
        return elapsed >= TimeSpan.FromSeconds(-5) && elapsed < TimeSpan.FromSeconds(75) &&
            Math.Abs((process.StartTime.ToUniversalTime() - state.StartedAt).TotalSeconds) < 2;
    }

    private static void Write(Snapshot state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FileName)!);
        var temp = FileName + "." + Environment.ProcessId + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(state));
        File.Move(temp, FileName, true);
    }
}
