using System.Runtime.InteropServices;

namespace ConnectLive.Unlock;

/// <summary>SCM lifetime only; no interactive UI, registry persistence or installer.</summary>
internal static class ServiceHost
{
    private delegate void ServiceMain(int count, IntPtr args);
    private delegate uint Handler(uint control, uint eventType, IntPtr eventData, IntPtr context);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Entry { [MarshalAs(UnmanagedType.LPWStr)] public string? Name; public ServiceMain? Main; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Status { public uint Type, State, Accepts, Error, SpecificError, Checkpoint, WaitHint; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool StartServiceCtrlDispatcher([In] Entry[] entries);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterServiceCtrlHandlerEx(string name, Handler handler, IntPtr context);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetServiceStatus(IntPtr handle, ref Status status);
    private static readonly CancellationTokenSource Stop = new();
    private static Handler? _handler;
    private static ServiceMain? _main;
    internal static int Run(Func<CancellationToken, Task> serve)
    {
        _handler = (control, _, _, _) => { if (control is 1 or 5) Stop.Cancel(); return 0; };
        _main = (_, _) =>
        {
            var handle = RegisterServiceCtrlHandlerEx("ConnectLiveUnlock", _handler, IntPtr.Zero);
            if (handle == IntPtr.Zero) return;
            var state = new Status { Type = 0x10, State = 4, Accepts = 1 | 4 };
            SetServiceStatus(handle, ref state);
            try { serve(Stop.Token).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) { }
            catch { state.Error = 1; }
            finally { state.State = 1; state.Accepts = 0; SetServiceStatus(handle, ref state); }
        };
        return StartServiceCtrlDispatcher(new[] { new Entry { Name = "ConnectLiveUnlock", Main = _main }, new Entry() }) ? 0 : 1;
    }
}
