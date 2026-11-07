using System.Runtime.InteropServices;
using ConnectLive.Agent;
using SIPSorceryMedia.Encoders;

int passed = 0;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
void Test(string name, Action test) { test(); passed++; Console.WriteLine($"PASS: {name}"); }
NativeVideoFinding One(FakeNativeProbe probe) => Vp8NativeDiagnostics.Inspect(probe).Single();

Test("missing asset is distinct from a missing runtime", () =>
{
    var p = new FakeNativeProbe();
    p.Images.Clear();
    var result = One(p);
    Check(result.State == "missing-native-asset", result.State);
    Check(result.Action.Contains("Platform=AnyCPU/x64") && result.Action.Contains("NuGet"), "Package restore guidance absent");
    Check(p.AssetLoads == 0 && p.DependencyLoads == 0, "Do not load an absent asset");
});
Test("native architecture is compared with the process, not assumed from the OS", () =>
{
    var p = new FakeNativeProbe();
    p.Images[p.Candidates[0].Path] = (ushort)0x014c;
    Check(One(p).State == "architecture-mismatch", "x86 DLL in x64 process");
    Check(p.AssetLoads == 0, "Wrong-architecture candidate must not be loaded");
    p.ProcessArchitecture = Architecture.X86;
    Check(One(p).State == "native-load-ok", "matching x86 supported by package");
});
Test("ARM64 process is not promised an absent ARM64 package asset", () =>
{
    var p = new FakeNativeProbe { ProcessArchitecture = Architecture.Arm64 };
    Check(One(p).State == "unsupported-process-architecture" && p.AssetLoads == 0, "ARM64 must not load x64 DLL natively");
});
Test("non-Windows inspection is explicitly unverified", () =>
{
    var p = new FakeNativeProbe { IsWindows = false };
    Check(One(p).State == "unsupported-os" && p.AssetLoads == 0, "Do not emulate Windows evidence");
});
Test("unreadable files are not mislabeled missing", () =>
{
    var p = new FakeNativeProbe();
    p.Images[p.Candidates[0].Path] = new UnauthorizedAccessException("PRIVATE-PATH");
    var result = One(p);
    Check(result.State == "inspection-incomplete" && !result.Evidence.Contains("PRIVATE-PATH"), "Read error/privacy classification");
});
Test("invalid PE is distinct from architecture mismatch", () =>
{
    var p = new FakeNativeProbe();
    p.Images[p.Candidates[0].Path] = new BadImageFormatException();
    Check(One(p).State == "invalid-native-image" && p.AssetLoads == 0, "Corrupt image handling");
});
Test("missing VC runtime produces official process-matched repair advice", () =>
{
    var p = new FakeNativeProbe { AssetError = 126 };
    p.DependencyErrors["VCRUNTIME140.dll"] = 126;
    var result = One(p);
    Check(result.State == "runtime-dependency-unavailable", result.State);
    Check(result.Evidence.Contains("VCRUNTIME140.dll:win32=126"), "Specific dependency evidence absent");
    Check(result.Action.Contains("X64 PROCESS") && result.Action.Contains(Vp8NativeDiagnostics.RedistHelp), "Runtime source/architecture");
    Check(!result.Action.Contains("Windows servicing/repair"), "Do not diagnose healthy UCRT as missing");
    Check(p.DependencyLoads == 7, "Inspect every documented runtime import");
});
Test("Universal CRT is checked as loader API sets, not file presence", () =>
{
    var p = new FakeNativeProbe { AssetError = 126 };
    p.DependencyErrors[Vp8NativeDiagnostics.RuntimeImports[1]] = 126;
    var result = One(p);
    Check(result.Action.Contains(Vp8NativeDiagnostics.UcrtHelp), "Windows-servicing guidance absent");
    Check(!result.Action.Contains("Install/repair the Microsoft Visual C++"), "Do not diagnose a working VC runtime as missing");
});
Test("both failed runtime families are reported without assuming installation state", () =>
{
    var p = new FakeNativeProbe { AssetError = 126 };
    p.DependencyErrors["VCRUNTIME140.dll"] = 193;
    p.DependencyErrors[Vp8NativeDiagnostics.RuntimeImports[2]] = 5;
    var result = One(p);
    Check(result.Evidence.Contains("win32=193") && result.Evidence.Contains("win32=5"), "Preserve loader error codes");
    Check(result.Evidence.Contains("blocked") && result.Action.Contains(Vp8NativeDiagnostics.RedistHelp) &&
        result.Action.Contains(Vp8NativeDiagnostics.UcrtHelp), "Do not collapse all failures into absent files");
});
Test("module-not-found with healthy direct imports stays unresolved", () =>
{
    var result = One(new FakeNativeProbe { AssetError = 126 });
    Check(result.State == "native-load-failed" && result.Evidence.Contains("not identified"), "126 is ambiguous");
    Check(!result.Action.Contains("Install/repair"), "Do not promise a redistributable will fix an unidentified cause");
});
foreach (var (error, state) in new[] { (193, "bad-native-image"), (127, "native-entry-point-missing"),
    (5, "native-load-blocked"), (577, "native-load-blocked"), (1260, "native-load-blocked"), (1114, "native-load-failed") })
{
    Test($"Windows loader error {error} preserves evidence", () =>
    {
        var result = One(new FakeNativeProbe { AssetError = error });
        Check(result.State == state && result.Evidence.Contains($"win32={error}"), "Loader classification");
        Check(result.Action.Contains("Do not disable security"), "Must not weaken controls");
    });
}
Test("native load success is not encoding or negotiation success", () =>
{
    var result = One(new FakeNativeProbe());
    Check(result.State == "native-load-ok" && result.Evidence.Contains("not the managed encoder"), "Bound evidence");
});
Test("single-file extraction candidates are inspected without requiring a sidecar", () =>
{
    var p = new FakeNativeProbe();
    p.Images.Clear();
    p.Candidates.Add(new("/test/extracted/vpxmd.dll", "host-native[0]/vpxmd.dll"));
    p.Images["/test/extracted/vpxmd.dll"] = (ushort)0x8664;
    Check(One(p).State == "native-load-ok", "Do not falsely report missing sidecar for an extracted DLL");
});
Test("multiple candidates remain separate evidence, not a guessed resolved path", () =>
{
    var p = new FakeNativeProbe();
    p.Images[p.Candidates[0].Path] = (ushort)0x014c;
    p.Candidates.Add(new("/test/extracted/vpxmd.dll", "host-native[0]/vpxmd.dll"));
    p.Images["/test/extracted/vpxmd.dll"] = (ushort)0x8664;
    var results = Vp8NativeDiagnostics.Inspect(p);
    Check(results.Select(r => r.State).SequenceEqual(new[] { "architecture-mismatch", "native-load-ok" }), "Preserve mixed evidence");
});
Test("candidate discovery uses only absolute app and host-native roots", () =>
{
    var app = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "preflight-app"));
    var extraction = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "preflight-extraction"));
    var locations = WindowsVp8NativeProbe.BuildLocations(app,
        string.Join(Path.PathSeparator, app, extraction, "relative-untrusted", ""));
    Check(locations.Count == 2 && locations[1].Path == Path.Combine(extraction, "vpxmd.dll"), "Deduplicate/retain extraction");
    Check(!locations.Any(p => p.Label.Contains(Path.GetTempPath())), "Do not log private directory names");
});
Test("PE parser reads machine headers and rejects non-PE data without loading", () =>
{
    var fixture = Path.Combine(Path.GetTempPath(), $"video-preflight-{Guid.NewGuid():N}.bin");
    try
    {
        // Portable test assembly bytes are only a PE-parser fixture; no Agent
        // binary is compiled and no fixture is ever loaded as native code.
        var bytes = File.ReadAllBytes(typeof(FakeNativeProbe).Assembly.Location);
        int peOffset = BitConverter.ToInt32(bytes, 0x3c);
        // A console assembly's PE header is executable, even with a .dll
        // filename. Mark only this never-executed fixture as a DLL.
        ushort characteristics = BitConverter.ToUInt16(bytes, peOffset + 22);
        BitConverter.GetBytes((ushort)(characteristics | 0x2000)).CopyTo(bytes, peOffset + 22);
        var probe = new WindowsVp8NativeProbe();
        foreach (ushort machine in new ushort[] { 0x014c, 0x8664, 0xaa64 })
        {
            BitConverter.GetBytes(machine).CopyTo(bytes, peOffset + 4);
            File.WriteAllBytes(fixture, bytes);
            Check(probe.ReadMachine(fixture) == machine, "Incorrect PE machine");
        }
        File.WriteAllText(fixture, "not a DLL");
        try { probe.ReadMachine(fixture); throw new Exception("Invalid image accepted"); }
        catch (BadImageFormatException) { }
    }
    finally { File.Delete(fixture); }
});
Test("wrapped native exceptions are explained without private messages", () =>
{
    var result = Vp8NativeDiagnostics.ExplainProbeFailure(
        new TypeInitializationException("private-type", new DllNotFoundException("PRIVATE-PATH")));
    Check(result.Contains("DllNotFoundException") && result.Contains("does not identify which DLL"), "Unwrap native error");
    Check(!result.Contains("PRIVATE-PATH") && !result.Contains("private-type"), "Do not log raw loader messages");
    Check(Vp8NativeDiagnostics.ExplainProbeFailure(new EntryPointNotFoundException()).Contains("entry point missing"), "Missing export");
    Check(Vp8NativeDiagnostics.ExplainProbeFailure(new BadImageFormatException()).Contains("architecture incompatible"), "Bad image");
    Check(Vp8NativeDiagnostics.ExplainProbeFailure(new InvalidOperationException()).Contains("not established"), "Unrelated failure");
});
Test("failed synthetic encode and failed native cleanup do not escape the VP8 boundary", () =>
{
    VpxVideoEncoder.Reset();
    VpxVideoEncoder.EncodeFailure = new DllNotFoundException("PRIVATE-PATH");
    VpxVideoEncoder.DisposeFailure = new DllNotFoundException("PRIVATE-PATH");
    Check(Vp8FrameEncoder.TryCreate() == null && VpxVideoEncoder.Disposals == 1, "Dispose once and return unavailable");
    Check(!Log.Lines.Any(l => l.Contains("PRIVATE-PATH")), "Probe/cleanup exception messages leaked");
});
Test("empty encode does not advertise a usable VP8 encoder", () =>
{
    VpxVideoEncoder.Reset();
    VpxVideoEncoder.EmptyFrame = true;
    Check(Vp8FrameEncoder.TryCreate() == null && VpxVideoEncoder.Disposals == 1, "Empty sample is unavailable");
});
Test("inventory failure never gates a successful actual VP8 probe", () =>
{
    // On Linux inventory says unsupported-os. The managed fake still succeeds,
    // demonstrating that inventory is diagnostic rather than an availability gate.
    VpxVideoEncoder.Reset();
    using var encoder = Vp8FrameEncoder.TryCreate();
    Check(encoder != null, "Only actual encode determines VP8 probe success");
});
Test("cleanup errors detach the old encoder and are not retried", () =>
{
    VpxVideoEncoder.Reset();
    var encoder = Vp8FrameEncoder.TryCreate()!;
    VpxVideoEncoder.DisposeFailure = new DllNotFoundException();
    Check(encoder.Encode(new byte[32 * 32 * 4], 32, 32)?.Length > 0, "Geometry change must replace detached instance");
    encoder.Dispose();
    encoder.Dispose();
    Check(VpxVideoEncoder.Disposals == 2, "Each instance disposed only once");
    Check(encoder.Encode(new byte[16 * 16 * 4], 16, 16) == null, "Closed encoder cannot revive");
});
Test("startup checks are once-only and report H.264 separately when VP8 is unavailable", () =>
{
    VpxVideoEncoder.Reset();
    VpxVideoEncoder.EncodeFailure = new DllNotFoundException();
    VpxVideoEncoder.DisposeFailure = new DllNotFoundException();
    VideoPreflight.LogStartup();
    VideoPreflight.LogStartup();
    Check(HwEncoderProbe.Calls == 1 && CodecPolicy.Calls == 1 && VpxVideoEncoder.Encodes == 1, "Startup idempotence/independence");
    Check(Log.Lines.Any(l => l.Contains("VP8=unavailable") && l.Contains("not an encoding test")), "Honest codec summary");
});

// Optional non-executing check against DLLs extracted from the exact official
// nupkg. This only parses PE headers; LoadLibraryEx is never invoked here.
if (args.Length == 1)
{
    Test("official NuGet x64/x86 DLL machine headers match the documented package", () =>
    {
        var parser = new WindowsVp8NativeProbe();
        Check(parser.ReadMachine(Path.Combine(args[0], "build", "x64", "vpxmd.dll")) == 0x8664, "Official x64");
        Check(parser.ReadMachine(Path.Combine(args[0], "build", "x86", "vpxmd.dll")) == 0x014c, "Official x86");
    });
}
Console.WriteLine($"{passed} portable checks passed. Native Windows loading/encoding/session behavior NOT verified.");
