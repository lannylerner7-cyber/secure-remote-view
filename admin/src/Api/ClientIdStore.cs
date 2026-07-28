using System;
using System.IO;

namespace ConnectLive.Admin.Api;

/// <summary>
/// Persistent per-install routing tag for this physical admin machine.
///
/// Stored as plain text at %AppData%\ConnectLiveAdmin\client.id. It is NOT a
/// secret — the backend never uses it for authentication. It only tells the
/// agent "route WebRTC signals/inputs to this specific admin console" so
/// that when the same technician signs in on two machines the agent can
/// tell them apart and cleanly hand control from one box to the other.
///
/// Deleting the file (or copying ConnectLiveAdmin.exe to a different
/// Windows profile) yields a brand new GUID → the previous physical box
/// is now treated as "another machine" for take-over purposes.
/// </summary>
public static class ClientIdStore
{
    private static readonly string Dir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ConnectLiveAdmin");
    private static readonly string Path_ = Path.Combine(Dir, "client.id");

    public static string LoadOrCreate()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            if (File.Exists(Path_))
            {
                var v = File.ReadAllText(Path_).Trim();
                if (Guid.TryParse(v, out _)) return v;
            }
        }
        catch { }

        var id = Guid.NewGuid().ToString("N");
        try { File.WriteAllText(Path_, id); } catch { }
        return id;
    }
}
