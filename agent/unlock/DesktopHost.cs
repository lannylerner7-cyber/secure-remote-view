using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace ConnectLive.Unlock;

internal static class DesktopHost
{
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, uint size, out uint needed);
    [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

    internal static bool OnLockedDesktop(int session)
    {
        if (WindowsSession.CurrentId != session || WindowsSession.Locked(session) != true) return false;
        var desktop = OpenInputDesktop(0, false, 1 /* DESKTOP_READOBJECTS */);
        if (desktop == IntPtr.Zero) return false;
        try
        {
            var name = new StringBuilder(128);
            return GetUserObjectInformation(desktop, 2, name, 256, out _) &&
                string.Equals(name.ToString(), "Winlogon", StringComparison.OrdinalIgnoreCase) &&
                IsLockUiForeground(session);
        }
        finally { CloseDesktop(desktop); }
    }
    private static bool IsLockUiForeground(int session)
    {
        // UAC may also use a desktop named Winlogon. The name alone must not
        // turn this narrowly approved lock-screen feature into UAC control.
        try
        {
            var window = GetForegroundWindow();
            if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out var pid) == 0) return false;
            using var process = Process.GetProcessById(checked((int)pid));
            if (process.SessionId != session) return false;
            var path = process.MainModule?.FileName;
            var logonUi = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "LogonUI.exe");
            if (string.Equals(path, logonUi, StringComparison.OrdinalIgnoreCase))
                return UnlockPipe.ProcessSid(process) == "S-1-5-18";
            var lockApp = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "SystemApps", "Microsoft.LockApp_cw5n1h2txyewy", "LockApp.exe");
            if (!string.Equals(path, lockApp, StringComparison.OrdinalIgnoreCase)) return false;
            UnlockPipe.AssertProtected(lockApp);
            return true;
        }
        catch { return false; }
    }

    internal static int Run(int parentId, int session, string name)
    {
        using var parent = Process.GetProcessById(parentId);
        if (parent.SessionId != session || !OnLockedDesktop(session)) return 5;
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(125));
        using var pipe = UnlockPipe.Listen(name);
        using var input = new DesktopInput(session);
        try
        {
            using (var connect = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            {
                connect.CancelAfter(TimeSpan.FromSeconds(5));
                pipe.WaitForConnectionAsync(connect.Token).GetAwaiter().GetResult();
            }
            if (UnlockPipe.ClientPid(pipe) != parentId || parent.HasExited) return 5;
            var pinConsumed = false;
            while (!lifetime.IsCancellationRequested && !parent.HasExited)
            {
                using var lease = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                lease.CancelAfter(TimeSpan.FromSeconds(5));
                using var request = UnlockPipe.ReadAsync(pipe, lease.Token).GetAwaiter().GetResult();
                var locked = WindowsSession.Locked(session);
                if (locked == false)
                {
                    UnlockPipe.WriteAsync(pipe, new { phase = "unlocked" }, lease.Token).GetAwaiter().GetResult();
                    return 0;
                }
                if (!OnLockedDesktop(session)) return 5;
                var root = request.RootElement;
                var action = root.GetProperty("action").GetString();
                if (action == "frame")
                {
                    using var bitmap = Capture();
                    using var bytes = new MemoryStream();
                    // Local IPC compression only. This never goes to JPEG
                    // storage/fallback: the Agent re-encodes into WebRTC video.
                    bitmap.Save(bytes, ImageFormat.Png);
                    if (!OnLockedDesktop(session)) return 5;
                    UnlockPipe.WriteAsync(pipe, new { phase = "ready", width = bitmap.Width, height = bitmap.Height,
                        frame = Convert.ToBase64String(bytes.GetBuffer(), 0, checked((int)bytes.Length)) },
                        lease.Token, frame: true).GetAwaiter().GetResult();
                }
                else if (action == "input")
                {
                    input.Apply(root.GetProperty("input"));
                    UnlockPipe.WriteAsync(pipe, new { phase = "ready" }, lease.Token).GetAwaiter().GetResult();
                }
                else if (action == "pin")
                {
                    // One submission per helper lifetime, even when delivery
                    // fails or Windows rejects the credential.
                    if (pinConsumed) return 5;
                    pinConsumed = true;
                    var encoded = root.GetProperty("pinUtf8").GetBytesFromBase64();
                    try { input.Pin(encoded); }
                    finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(encoded); }
                    UnlockPipe.WriteAsync(pipe, new { phase = "submitted" }, lease.Token).GetAwaiter().GetResult();
                }
                else if (action == "cancel") return 0;
                else return 5;
            }
        }
        catch { return 1; }
        return 0;
    }

    private static Bitmap Capture()
    {
        int width = GetSystemMetrics(0), height = GetSystemMetrics(1);
        if (width is < 2 or > 7680 || height is < 2 or > 4320) throw new IOException("unlock_display_unsupported");
        using var native = new Bitmap(width, height, PixelFormat.Format32bppRgb);
        using (var graphics = Graphics.FromImage(native))
            graphics.CopyFromScreen(0, 0, 0, 0, native.Size, CopyPixelOperation.SourceCopy);
        double scale = Math.Min(1, 1920.0 / Math.Max(width, height));
        var output = new Bitmap(Math.Max(2, ((int)(width * scale)) & ~1), Math.Max(2, ((int)(height * scale)) & ~1),
            PixelFormat.Format32bppRgb);
        using (var graphics = Graphics.FromImage(output))
            graphics.DrawImage(native, 0, 0, output.Width, output.Height);
        return output;
    }
}
