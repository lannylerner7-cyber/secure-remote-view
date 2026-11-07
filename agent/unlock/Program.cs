using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace ConnectLive.Unlock;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (WindowsIdentity.GetCurrent().User?.Value != "S-1-5-18") return 5;
            if (args.Length == 1 && args[0] == "--service")
                return ServiceHost.Run(Broker);
            if (args.Length == 4 && args[0] == "--desktop" && int.TryParse(args[1], out var parent) &&
                int.TryParse(args[2], out var session) &&
                System.Text.RegularExpressions.Regex.IsMatch(args[3], @"^ConnectLive\.UnlockSession\.[0-9a-f]{32}$"))
                return DesktopHost.Run(parent, session, args[3]);
            return 2;
        }
        catch { return 1; } // No exception/body dumps from the privileged boundary.
    }

    private sealed record Policy(string DeviceId, string AuthorizationId, string Origin,
        string UserSid, string AgentPath, string AgentSha256);
    private static Policy ReadPolicy()
    {
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "ConnectLiveUnlock", "policy.json");
        if ((File.GetAttributes(Path.GetDirectoryName(path)!) & FileAttributes.ReparsePoint) != 0 ||
            (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("unlock_policy_invalid");
        UnlockPipe.AssertProtected(path);
        UnlockPipe.AssertProtected(Path.GetDirectoryName(path)!);
        var policy = JsonSerializer.Deserialize<Policy>(File.ReadAllText(path)) ?? throw new IOException("unlock_policy_missing");
        if (!Guid.TryParse(policy.DeviceId, out _) || !Guid.TryParse(policy.AuthorizationId, out _) ||
            !string.Equals(policy.AgentPath, UnlockPipe.ProtectedPath("ConnectLive.exe"), StringComparison.OrdinalIgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(policy.AgentSha256, "^[A-Fa-f0-9]{64}$"))
            throw new IOException("unlock_policy_invalid");
        return policy;
    }
    private static async Task Broker(CancellationToken stop)
    {
        Process? helper = null;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                using var pipe = UnlockPipe.Listen(UnlockPipe.BrokerName);
                await pipe.WaitForConnectionAsync(stop);
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
                deadline.CancelAfter(TimeSpan.FromSeconds(4));
                try
                {
                    var policy = ReadPolicy();
                    using var client = Process.GetProcessById(UnlockPipe.ClientPid(pipe));
                    var clientPath = client.MainModule?.FileName;
                    if (client.SessionId <= 0 || clientPath == null ||
                        !string.Equals(clientPath, policy.AgentPath, StringComparison.OrdinalIgnoreCase) ||
                        UnlockPipe.ProcessSid(client) != policy.UserSid ||
                        !string.Equals(HashFile(clientPath),
                            policy.AgentSha256, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("unlock_client_denied");
                    using var request = await UnlockPipe.ReadAsync(pipe, deadline.Token);
                    var root = request.RootElement;
                    if (root.GetProperty("deviceId").GetString() != policy.DeviceId ||
                        root.GetProperty("authorizationId").GetString() != policy.AuthorizationId ||
                        root.GetProperty("origin").GetString() != policy.Origin)
                        throw new IOException("unlock_binding_denied");
                    var action = root.GetProperty("action").GetString();
                    if (action == "status")
                        await UnlockPipe.WriteAsync(pipe, new { ready = true, locked = WindowsSession.Locked(client.SessionId) }, deadline.Token);
                    else if (action == "begin")
                    {
                        if (WindowsSession.Locked(client.SessionId) != true) throw new IOException("unlock_not_locked");
                        if (helper is { HasExited: false }) helper.Kill(entireProcessTree: true);
                        helper?.Dispose();
                        var name = "ConnectLive.UnlockSession." + Guid.NewGuid().ToString("N");
                        helper = NativeProcess.StartDesktop(client.Id, client.SessionId, name);
                        await UnlockPipe.WriteAsync(pipe, new { ready = true, pipe = name, helperPid = helper.Id }, deadline.Token);
                    }
                    else if (action == "sas")
                    {
                        if (WindowsSession.Locked(client.SessionId) != true) throw new IOException("unlock_not_locked");
                        pipe.RunAsClient(() => NativeProcess.SendSAS(true));
                        await UnlockPipe.WriteAsync(pipe, new { requested = true }, deadline.Token);
                    }
                    else throw new IOException("unlock_action_denied");
                }
                catch
                {
                    try { await UnlockPipe.WriteAsync(pipe, new { ready = false, reason = "helper_rejected" }, deadline.Token); }
                    catch { }
                }
            }
        }
        finally
        {
            if (helper is { HasExited: false }) helper.Kill(entireProcessTree: true);
            helper?.Dispose();
        }
    }
    private static string HashFile(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(file));
    }
}
