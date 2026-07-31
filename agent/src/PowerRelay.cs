using System;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>
/// Executes power_commands delivered via the heartbeat response.
/// Two modes:
///   role="relay"  → broadcast a Wake-on-LAN magic packet to payload.mac
///                   on every up IPv4 NIC's directed-broadcast address (UDP 9/7).
///   role="target" → execute a local power action (lock/logoff/reboot/shutdown).
///
/// After each command we call /api/public/agent/power/:id/ack so the
/// admin console can flip the row to "delivered"/"failed".
///
/// Local shutdown/reboot use shutdown.exe with a 5s window so the user
/// can cancel via `shutdown /a` (a tray toast surfaces this).
/// </summary>
public static class PowerRelay
{
    public static async Task HandleAsync(ApiClient api, JsonElement command, CancellationToken ct)
    {
        string id = command.TryGetProperty("id", out var idEl) ? (idEl.GetString() ?? "") : "";
        string kind = command.TryGetProperty("kind", out var kindEl) ? (kindEl.GetString() ?? "") : "";
        string role = command.TryGetProperty("role", out var r) ? (r.GetString() ?? "target") : "target";
        JsonElement payload = command.TryGetProperty("payload", out var p) ? p : default;
        if (id.Length == 0) return;

        string state = "delivered";
        string? error = null;

        try
        {
            if (kind == "wake" && role == "relay")
            {
                var mac = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("mac", out var m)
                    ? m.GetString() : null;
                if (string.IsNullOrWhiteSpace(mac)) throw new InvalidOperationException("wake: missing mac");
                SendMagicPacket(mac!);
                Log.Info($"power/wake broadcast for {mac} (cmd {id})");
            }
            else if (kind == "lock")
            {
                RunHidden("rundll32.exe", "user32.dll,LockWorkStation");
            }
            else if (kind == "logoff")
            {
                RunHidden("shutdown.exe", "/l /f");
            }
            else if (kind == "reboot")
            {
                RunHidden("shutdown.exe", "/r /t 5 /c \"ConnectLive: reboot in 5s. Run 'shutdown /a' to cancel.\"");
            }
            else if (kind == "shutdown")
            {
                RunHidden("shutdown.exe", "/s /t 5 /c \"ConnectLive: shutdown in 5s. Run 'shutdown /a' to cancel.\"");
            }
            else if (kind == "wake_agent")
            {
                // We're already running, so "wake" simply means: surface the
                // session UI and force an immediate heartbeat. Previously this
                // fell through to the unsupported branch and acked "failed".
                OnWakeAgent?.Invoke();
                Log.Info($"power/wake_agent surfaced UI (cmd {id})");
            }
            else
            {
                throw new InvalidOperationException($"unsupported command {kind}/{role}");
            }
        }
        catch (Exception ex)
        {
            state = "failed";
            error = ex.Message;
            Log.Warn($"power/{kind} failed: {ex.Message}");
        }

        try { await api.AckPowerCommandAsync(id, state, error, ct); } catch { /* best-effort */ }
    }

    private static void RunHidden(string exe, string args)
    {
        var psi = new ProcessStartInfo(exe, args)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        using var _ = Process.Start(psi);
    }

    private static void SendMagicPacket(string mac)
    {
        var bytes = ParseMac(mac);
        var packet = new byte[6 + 16 * 6];
        for (int i = 0; i < 6; i++) packet[i] = 0xFF;
        for (int i = 0; i < 16; i++) Buffer.BlockCopy(bytes, 0, packet, 6 + i * 6, 6);

        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var ua in nic.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                try
                {
                    var directed = DirectedBroadcast(ua.Address, ua.IPv4Mask);
                    BroadcastTo(packet, directed);
                }
                catch { /* NIC-specific; try next */ }
            }
        }
        try { BroadcastTo(packet, IPAddress.Broadcast); } catch { }
    }

    private static void BroadcastTo(byte[] packet, IPAddress addr)
    {
        using var udp = new UdpClient { EnableBroadcast = true };
        udp.Send(packet, packet.Length, new IPEndPoint(addr, 9));
        udp.Send(packet, packet.Length, new IPEndPoint(addr, 7));
    }

    private static IPAddress DirectedBroadcast(IPAddress ip, IPAddress mask)
    {
        var ipBytes = ip.GetAddressBytes();
        var maskBytes = mask.GetAddressBytes();
        var broadcast = new byte[ipBytes.Length];
        for (int i = 0; i < ipBytes.Length; i++)
            broadcast[i] = (byte)(ipBytes[i] | ~maskBytes[i]);
        return new IPAddress(broadcast);
    }

    /// <summary>Returns { subnet_v4, mac, ipv4 } for the first up IPv4 NIC.</summary>
    public static (string? subnet, string? mac, string? ipv4) LocalLanFingerprint()
    {
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var ua in nic.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                if (ua.IPv4Mask == null) continue;
                var ipBytes = ua.Address.GetAddressBytes();
                var maskBytes = ua.IPv4Mask.GetAddressBytes();
                var netBytes = new byte[4];
                for (int i = 0; i < 4; i++) netBytes[i] = (byte)(ipBytes[i] & maskBytes[i]);
                var prefix = MaskToPrefix(maskBytes);
                var subnet = $"{new IPAddress(netBytes)}/{prefix}";
                var macBytes = nic.GetPhysicalAddress().GetAddressBytes();
                var mac = macBytes.Length == 6
                    ? string.Join(":", macBytes.Select(b => b.ToString("x2")))
                    : null;
                return (subnet, mac, ua.Address.ToString());
            }
        }
        return (null, null, null);
    }

    private static int MaskToPrefix(byte[] mask)
    {
        int c = 0;
        foreach (var b in mask)
            for (int i = 7; i >= 0; i--) if ((b & (1 << i)) != 0) c++; else return c;
        return c;
    }

    private static byte[] ParseMac(string mac)
    {
        var clean = new string(mac.Where(c => Uri.IsHexDigit(c)).ToArray());
        if (clean.Length != 12) throw new FormatException($"bad mac '{mac}'");
        var b = new byte[6];
        for (int i = 0; i < 6; i++) b[i] = Convert.ToByte(clean.Substring(i * 2, 2), 16);
        return b;
    }
}
