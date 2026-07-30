using System;
using System.IO;
using System.Text;

namespace ConnectLive.Admin.Diag;

/// <summary>
/// Tiny append-only diagnostics log at
/// %AppData%\ConnectLiveAdmin\admin.log.
///
/// The console used to be able to fail before any window appeared with no
/// message at all (blocked dispatcher, bad config, XAML resource error).
/// Every startup milestone and every unhandled exception is written here so
/// "it starts but nothing shows" is always explainable after the fact.
/// </summary>
public static class Log
{
    private static readonly object Gate = new();

    private static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ConnectLiveAdmin");

    public static string FilePath { get; } = Path.Combine(Dir, "admin.log");

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Dir);
                // Keep the file small — rotate past ~512 KB.
                try
                {
                    var fi = new FileInfo(FilePath);
                    if (fi.Exists && fi.Length > 512 * 1024)
                    {
                        var old = FilePath + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(FilePath, old);
                    }
                }
                catch { }

                File.AppendAllText(FilePath,
                    $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}  {message}{Environment.NewLine}",
                    Encoding.UTF8);
            }
        }
        catch { /* diagnostics must never throw */ }
    }

    public static void Error(string context, Exception ex)
        => Write($"ERROR {context}: {ex.GetType().Name}: {ex.Message}{Environment.NewLine}{ex.StackTrace}");
}
