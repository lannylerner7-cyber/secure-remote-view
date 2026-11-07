using System.Runtime.InteropServices;
using ConnectLive.Agent;

// All native/encoder behavior below is simulated. No network or desktop APIs.
internal sealed class FakeNativeProbe : IVp8NativeProbe
{
    public bool IsWindows { get; set; } = true;
    public Architecture ProcessArchitecture { get; set; } = Architecture.X64;
    public List<NativeVideoLocation> Candidates { get; } = new() { new("/test/app/vpxmd.dll", "app-base/vpxmd.dll") };
    public Dictionary<string, object> Images { get; } = new() { ["/test/app/vpxmd.dll"] = (ushort)0x8664 };
    public int AssetError { get; set; }
    public Dictionary<string, int> DependencyErrors { get; } = new();
    public int AssetLoads { get; private set; }
    public int DependencyLoads { get; private set; }
    public IReadOnlyList<NativeVideoLocation> Locations() => Candidates;
    public ushort ReadMachine(string path)
    {
        if (!Images.TryGetValue(path, out var image)) throw new FileNotFoundException();
        if (image is Exception ex) throw ex;
        return (ushort)image;
    }
    public int LoadAsset(string path) { AssetLoads++; return AssetError; }
    public int LoadDependency(string name, string assetPath)
    {
        DependencyLoads++;
        return DependencyErrors.GetValueOrDefault(name);
    }
}

namespace ConnectLive.Agent
{
    internal static class Log
    {
        internal static readonly List<string> Lines = new();
        internal static void Info(string text) => Lines.Add(text);
        internal static void Warn(string text) => Lines.Add(text);
    }
    internal static class HwEncoderProbe
    {
        internal static int Calls;
        internal static void LogCapability() { Calls++; Log.Info("simulated H.264 candidate discovery"); }
    }
    internal static class CodecPolicy
    {
        internal static int Calls;
        internal static void LogPolicy() { Calls++; }
    }
}

namespace SIPSorceryMedia.Abstractions
{
    public enum VideoPixelFormatsEnum { Bgra }
    public enum VideoCodecsEnum { VP8 }
}

namespace SIPSorceryMedia.Encoders
{
    // Tests exercise the real Agent wrapper and its cleanup boundaries, but
    // deliberately do not reference or execute the package's native encoder.
    public sealed class VpxVideoEncoder : IDisposable
    {
        public static Exception? EncodeFailure;
        public static Exception? DisposeFailure;
        public static bool EmptyFrame;
        public static int Disposals;
        public static int Encodes;
        public static void Reset()
        {
            EncodeFailure = DisposeFailure = null;
            EmptyFrame = false;
            Disposals = Encodes = 0;
        }
        public void ForceKeyFrame() { }
        public byte[]? EncodeVideo(int width, int height, byte[] sample,
            Abstractions.VideoPixelFormatsEnum format, Abstractions.VideoCodecsEnum codec)
        {
            Encodes++;
            if (EncodeFailure != null) throw EncodeFailure;
            return EmptyFrame ? Array.Empty<byte>() : new byte[] { 1 };
        }
        public void Dispose()
        {
            Disposals++;
            if (DisposeFailure != null) throw DisposeFailure;
        }
    }
}
