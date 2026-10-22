using System;
using System.IO;

namespace ConnectLive.Agent;

/// <summary>
/// A local withdrawal is independent of server license/session state.
/// No enrollment, heartbeat, updater or startup recovery may clear it.
/// Reauthorization is deliberately not implemented by deleting this marker.
/// </summary>
internal static class LocalAccessState
{
    private static string MarkerPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ConnectLive", "access-disabled");

    internal static bool IsDisabled()
        => IsDisabledAt(MarkerPath);

    internal static bool IsDisabledAt(string markerPath)
    {
        try
        {
            // Open rather than File.Exists: access errors must fail closed.
            using var stream = File.OpenRead(markerPath);
            return true;
        }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
        catch { return true; }
    }

    internal static void Disable()
        => DisableAt(MarkerPath);

    // Called only after a successful foreground agreement and protected save.
    internal static void CompleteForegroundReauthorization()
    {
        if (File.Exists(MarkerPath)) File.Delete(MarkerPath);
        if (IsDisabled()) throw new IOException("Could not clear local withdrawal; access remains disabled.");
    }

    internal static void DisableAt(string markerPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(markerPath)!);
        using var stream = new FileStream(markerPath, FileMode.Create,
            FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        stream.WriteByte(1);
        stream.Flush(flushToDisk: true);
    }
}
