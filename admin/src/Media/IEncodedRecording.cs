using System;

namespace ConnectLive.Admin.Media;

/// <summary>Stores the negotiated compressed video; never re-encodes or captures the desktop.</summary>
public interface IEncodedRecording : IDisposable
{
    string Path { get; }
    uint FrameCount { get; }
    void WriteFrame(byte[] frame);
    string? Stop();
}
