using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace ConnectLive.Agent;

/// <summary>Verified default communications microphone, 8 kHz PCM -> PCMU. Never loopback or disk.</summary>
internal sealed class WindowsMicrophone : IDisposable
{
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct Format { public ushort Tag, Channels; public uint Rate, BytesPerSecond; public ushort Align, Bits, Extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Header { public IntPtr Data; public uint Length, Recorded; public IntPtr User; public uint Flags, Loops; public IntPtr Next, Reserved; }
    private delegate void Callback(IntPtr input, uint message, IntPtr instance, IntPtr param1, IntPtr param2);
    [DllImport("winmm.dll")] private static extern uint waveInOpen(out IntPtr input, uint device, ref Format format, Callback callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] private static extern uint waveInPrepareHeader(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInAddBuffer(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInStart(IntPtr input);
    [DllImport("winmm.dll")] private static extern uint waveInStop(IntPtr input);
    [DllImport("winmm.dll")] private static extern uint waveInReset(IntPtr input);
    [DllImport("winmm.dll")] private static extern uint waveInUnprepareHeader(IntPtr input, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInClose(IntPtr input);
    private readonly List<(IntPtr Header, IntPtr Bytes)> _buffers = new();
    private readonly Channel<(byte[] Bytes, long At, IntPtr Header)> _queue = Channel.CreateBounded<(byte[], long, IntPtr)>(
        new BoundedChannelOptions(3) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly Callback _callback;
    private readonly Func<bool> _allowed;
    private readonly Action<byte[]> _send;
    private readonly Action<string> _failed;
    private readonly object _nativeGate = new();
    private IntPtr _input;
    private int _closed;
    private long _lastSample = Environment.TickCount64;
    private readonly Timer _watch;
    internal WindowsMicrophone(Func<bool> allowed, Action<byte[]> send, Action<string> failed)
    {
        _allowed = allowed; _send = send; _failed = failed; _callback = Captured;
        _watch = new Timer(_ => {
            if (_closed != 0) return;
            if (!_allowed()) { _failed("transport_failure"); Dispose(); }
            else if (Environment.TickCount64 - Interlocked.Read(ref _lastSample) > 3000)
            { _failed("device_unavailable"); Dispose(); }
        }, null, Timeout.Infinite, Timeout.Infinite);
        try
        {
            if (!_allowed()) throw new InvalidOperationException("permission_denied");
            if (OperatingSystem.IsWindows())
            {
                try
                {
                    var status = Windows.Devices.Enumeration.DeviceAccessInformation.CreateFromDeviceClass(
                        Windows.Devices.Enumeration.DeviceClass.AudioCapture).CurrentStatus;
                    if (status is Windows.Devices.Enumeration.DeviceAccessStatus.DeniedBySystem or
                        Windows.Devices.Enumeration.DeviceAccessStatus.DeniedByUser)
                        throw new UnauthorizedAccessException("permission_denied");
                }
                catch (UnauthorizedAccessException) { throw; }
                catch { /* Desktop privacy status may be unspecified. WinMM still enforces access. */ }
            }
            var selected = MicrophoneEndpoint.Select();
            var format = new Format { Tag = 1, Channels = 1, Rate = 8000, BytesPerSecond = 16000, Align = 2, Bits = 16 };
            uint result = waveInOpen(out _input, selected.Index, ref format, _callback, IntPtr.Zero, 0x30000);
            // MMSYSERR_ALLOCATED (4) means busy, not an established privacy denial.
            if (result != 0) throw new InvalidOperationException("device_unavailable");
            // Hot-plug/index changes must not switch capture to an unintended source.
            if (!MicrophoneEndpoint.Matches(_input, selected.EndpointId))
                throw new InvalidOperationException("device_unavailable");
            for (int i = 0; i < 3; i++)
            {
                IntPtr bytes = Marshal.AllocHGlobal(320), pointer = Marshal.AllocHGlobal(Marshal.SizeOf<Header>());
                _buffers.Add((pointer, bytes));
                Marshal.StructureToPtr(new Header { Data = bytes, Length = 320 }, pointer, false);
                if (waveInPrepareHeader(_input, pointer, (uint)Marshal.SizeOf<Header>()) != 0 ||
                    waveInAddBuffer(_input, pointer, (uint)Marshal.SizeOf<Header>()) != 0) throw new InvalidOperationException("device_unavailable");
            }
            if (!_allowed() || waveInStart(_input) != 0) throw new InvalidOperationException("device_unavailable");
            _ = SendLoop();
            _watch.Change(250,250);
        }
        catch { Dispose(); throw; }
    }
    private void Captured(IntPtr input, uint message, IntPtr instance, IntPtr param1, IntPtr param2)
    {
        if (message != 0x3C0 || Volatile.Read(ref _closed) != 0) return;
        try
        {
            var header = Marshal.PtrToStructure<Header>(param1);
            if (header.Recorded == 320 && _allowed())
            {
                var pcm = new byte[320]; Marshal.Copy(header.Data, pcm, 0, pcm.Length);
                var encoded = new byte[160];
                for (int i = 0; i < 160; i++) encoded[i] = MuLaw(BitConverter.ToInt16(pcm, i * 2));
                Array.Clear(pcm);
                Interlocked.Exchange(ref _lastSample, Environment.TickCount64);
                if (!_queue.Writer.TryWrite((encoded, Environment.TickCount64, param1)))
                    ThreadPool.QueueUserWorkItem(_ => _failed("transport_failure"));
            }
            else if (_closed == 0)
                _queue.Writer.TryWrite((Array.Empty<byte>(), Environment.TickCount64, param1));
        }
        catch { ThreadPool.QueueUserWorkItem(_ => _failed("device_unavailable")); }
    }
    private async Task SendLoop()
    {
        try
        {
            await foreach (var sample in _queue.Reader.ReadAllAsync())
            {
                // Bounded latest-audio-only queue: never replay buffered speech.
                if (_closed == 0 && _allowed() && sample.Bytes.Length == 160 && Environment.TickCount64 - sample.At < 60)
                    _send(sample.Bytes);
                Array.Clear(sample.Bytes);
                // Never call WinMM from its callback. The independent audio
                // worker returns capture buffers, dropping late speech.
                lock (_nativeGate)
                {
                    if (_closed == 0 && _allowed() && waveInAddBuffer(_input, sample.Header, (uint)Marshal.SizeOf<Header>()) != 0)
                        throw new InvalidOperationException("device_unavailable");
                }
            }
        }
        catch { _failed("transport_failure"); Dispose(); }
    }
    internal static byte MuLaw(short sample)
    {
        int value = sample, sign = value < 0 ? 0x80 : 0;
        if (value < 0) value = -value;
        value = Math.Min(32635, value) + 132;
        int exponent = 7;
        for (int mask = 0x4000; (value & mask) == 0 && exponent > 0; mask >>= 1) exponent--;
        return (byte)~(sign | exponent << 4 | value >> (exponent + 3) & 15);
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0) return;
        _watch.Dispose(); _queue.Writer.TryComplete();
        lock (_nativeGate)
        {
            if (_input != IntPtr.Zero)
            {
                waveInStop(_input); waveInReset(_input);
                foreach (var buffer in _buffers)
                {
                    waveInUnprepareHeader(_input, buffer.Header, (uint)Marshal.SizeOf<Header>());
                    Marshal.FreeHGlobal(buffer.Header); Marshal.FreeHGlobal(buffer.Bytes);
                }
                waveInClose(_input); _input = IntPtr.Zero;
            }
            _buffers.Clear();
        }
    }
}
