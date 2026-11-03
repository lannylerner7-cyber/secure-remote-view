using System;
using System.IO;

namespace ConnectLive.Agent;

internal static class ConfigFile
{
    internal static void Write(string path, string content)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, ".config-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                using var writer = new StreamWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
                writer.Write(content);
                writer.Flush();
                stream.Flush(true);
            }
            ConnectLive.Updates.DurableFile.Replace(temporary, path);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
