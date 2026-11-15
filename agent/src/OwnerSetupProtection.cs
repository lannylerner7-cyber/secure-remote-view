using System;
using System.IO;
using System.Threading;

namespace ConnectLive.Agent;

/// <summary>Cross-process media pause for explicit local PIN entry. Contains no credential.</summary>
internal sealed class OwnerSetupProtection : IDisposable
{
    private static readonly string Marker = Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData), "ConnectLive", "owner-pin-setup.lock");
    private readonly FileStream _lock;
    private static int _held;
    private int _disposed;
    internal static bool Active
    {
        get
        {
            if (Volatile.Read(ref _held) != 0) return true;
            try
            {
                // A live setup owns a Windows share-read-only writer. Trying
                // to open another writer proves whether its OS lock remains.
                // Do not expire protection just because a timer ran late.
                using var probe = new FileStream(Marker,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite);
                return false; // A crashed/closed owner left only a stale marker.
            }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch { return true; } // Sharing violation/unknown access fails closed.
        }
    }
    internal OwnerSetupProtection()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Marker)!);
        _lock = new FileStream(Marker, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
        try { _lock.WriteByte(1); _lock.Flush(true); Interlocked.Increment(ref _held); }
        catch { _lock.Dispose(); throw; }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed,1)!=0) return;
        _lock.Dispose(); Interlocked.Decrement(ref _held);
        try { File.Delete(Marker); } catch { }
    }
}
