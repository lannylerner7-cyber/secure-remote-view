using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace ConnectLive.Agent;

internal sealed record NativeVideoLocation(string Path, string Label);
internal sealed record NativeVideoFinding(string State, string Evidence, string Action);

// Injectable IO boundary: the portable tests never load a Windows DLL.
internal interface IVp8NativeProbe
{
    bool IsWindows { get; }
    Architecture ProcessArchitecture { get; }
    IReadOnlyList<NativeVideoLocation> Locations();
    ushort ReadMachine(string path);
    int LoadAsset(string path);
    int LoadDependency(string name, string assetPath);
}

/// <summary>
/// Diagnostic evidence, not a codec-selection gate or a dependency installer.
/// Package facts come from the official 10.0.4 nupkg and its PE import tables;
/// see agent/VIDEO-DEPENDENCIES.md. Recheck them before changing the package.
/// </summary>
internal static class Vp8NativeDiagnostics
{
    internal const string PackageVersion = "10.0.4";
    internal const string LibraryName = "vpxmd.dll";
    internal const string RedistHelp =
        "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist";
    internal const string UcrtHelp =
        "https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment";
    internal const string RestoreAction =
        "Restore SIPSorceryMedia.Encoders 10.0.4 from NuGet and rebuild the complete win-x64 output in a fresh folder. " +
        "Its targets choose x64 for MSBuild Platform=AnyCPU/x64, x86 for Platform=x86 (not by RuntimeIdentifier alone). " +
        "Keep all output files; for single-file builds also check native extraction. Do not obtain standalone replacement DLLs.";

    // Direct imports of BOTH package DLLs, excluding the Windows KERNEL32.dll.
    // API-set contracts are loader names, not files whose existence we can test.
    internal static readonly string[] RuntimeImports =
    {
        "VCRUNTIME140.dll",
        "api-ms-win-crt-utility-l1-1-0.dll",
        "api-ms-win-crt-convert-l1-1-0.dll",
        "api-ms-win-crt-heap-l1-1-0.dll",
        "api-ms-win-crt-runtime-l1-1-0.dll",
        "api-ms-win-crt-stdio-l1-1-0.dll",
        "api-ms-win-crt-math-l1-1-0.dll",
    };

    private static readonly object Gate = new();
    private static bool _logged;

    internal static void LogOnce()
    {
        lock (Gate)
        {
            if (_logged) return;
            _logged = true;
            try
            {
                Log.Info($"video preflight: SIPSorceryMedia.Encoders={PackageVersion}; " +
                    $"process={RuntimeInformation.ProcessArchitecture}; os={RuntimeInformation.OSArchitecture}; " +
                    "project target=win-x64; native checks are not proof of encoding or negotiation");
                Log.Info("video preflight: VP8 needs the package's vpxmd.dll, matching-process Visual C++ v14 " +
                    "runtime (VCRUNTIME140.dll), and Windows Universal CRT. The .NET SDK/runtime alone is not this prerequisite.");
                foreach (var finding in Inspect(new WindowsVp8NativeProbe()))
                {
                    var line = $"video preflight VP8: state={finding.State}; {finding.Evidence}";
                    if (finding.State == "native-load-ok") Log.Info(line);
                    else Log.Warn(line);
                    if (finding.Action.Length > 0) Log.Warn($"video preflight action: {finding.Action}");
                }
            }
            catch (Exception ex)
            {
                // Diagnostics must not take down startup or suppress hardware H.264.
                // Exception messages can include usernames and arbitrary paths.
                Log.Warn($"video preflight: inspection-incomplete ({ex.GetType().Name}, 0x{ex.HResult:X8}); " +
                    "actual encoder probe still required. See agent/VIDEO-DEPENDENCIES.md.");
            }
        }
    }

    internal static IReadOnlyList<NativeVideoFinding> Inspect(IVp8NativeProbe probe)
    {
        if (!probe.IsWindows)
            return new[] { new NativeVideoFinding("unsupported-os", "Windows native loader not exercised.",
                "Run the source manually on the designated Windows x64 test machine.") };
        var expected = probe.ProcessArchitecture switch
        {
            Architecture.X64 => (ushort)0x8664,
            Architecture.X86 => (ushort)0x014c,
            _ => (ushort)0,
        };
        if (expected == 0)
            return new[] { new NativeVideoFinding("unsupported-process-architecture",
                $"process={probe.ProcessArchitecture}; package ships only x86 and x64 native assets, not ARM64.",
                "Use the supported win-x64 Agent and matching x64 runtime; native ARM64 is not supplied by this package.") };

        var findings = new List<NativeVideoFinding>();
        var locations = probe.Locations();
        foreach (var location in locations)
        {
            ushort machine;
            try { machine = probe.ReadMachine(location.Path); }
            catch (FileNotFoundException) { continue; }
            catch (DirectoryNotFoundException) { continue; }
            catch (BadImageFormatException)
            {
                findings.Add(new("invalid-native-image", $"{location.Label}: not a readable Windows PE DLL.", RestoreAction));
                continue;
            }
            catch (Exception ex)
            {
                findings.Add(new("inspection-incomplete",
                    $"{location.Label}: read failed ({ex.GetType().Name}, 0x{ex.HResult:X8}); absence is not established.",
                    "Check the approved installation and endpoint-policy logs with your administrator; do not relax permissions."));
                continue;
            }

            if (machine != expected)
            {
                findings.Add(new("architecture-mismatch",
                    $"{location.Label}: PE machine=0x{machine:X4}, process={probe.ProcessArchitecture}; this candidate cannot load.",
                    RestoreAction));
                continue;
            }

            int error = probe.LoadAsset(location.Path);
            if (error == 0)
            {
                findings.Add(new("native-load-ok",
                    $"{location.Label}: PE matches {probe.ProcessArchitecture}; restricted Windows loader succeeded. " +
                    "This is a candidate load, not the managed encoder's synthetic encode or a live frame.", ""));
                continue;
            }
            if (error == 126) // ERROR_MOD_NOT_FOUND does not identify the missing module.
            {
                var failed = new List<string>();
                bool vcFailed = false, ucrtFailed = false;
                foreach (var name in RuntimeImports)
                {
                    int dependencyError = probe.LoadDependency(name, location.Path);
                    if (dependencyError == 0) continue;
                    failed.Add($"{name}:win32={dependencyError}");
                    if (name == "VCRUNTIME140.dll") vcFailed = true;
                    else ucrtFailed = true;
                }
                if (failed.Count > 0)
                {
                    string action = "";
                    if (vcFailed)
                        action += $"Install/repair the Microsoft Visual C++ v14 Redistributable matching the " +
                            $"{probe.ProcessArchitecture} PROCESS using Microsoft's supported installer: {RedistHelp}. ";
                    if (ucrtFailed)
                        action += $"Windows 10/11 supplies Universal CRT; have your administrator check Windows servicing/repair: {UcrtHelp}. ";
                    findings.Add(new("runtime-dependency-unavailable",
                        $"{location.Label}: asset present and matching architecture, native win32=126; " +
                        $"separate restricted dependency loads failed [{string.Join(", ", failed)}]. " +
                        "Missing, blocked, damaged or incompatible dependencies remain distinct possibilities.",
                        action + "No download, repair or permission change is performed by the Agent; restart it after an approved repair."));
                    continue;
                }
            }
            findings.Add(DescribeLoadFailure(location.Label, error));
        }
        if (findings.Count == 0)
            findings.Add(new("missing-native-asset",
                $"{LibraryName} absent from {locations.Count} probed app/host-native locations. " +
                "Other custom loader locations were not searched; the actual encoder probe remains authoritative.",
                RestoreAction));
        return findings;
    }

    internal static NativeVideoFinding DescribeLoadFailure(string label, int error) => new(
        error switch
        {
            193 => "bad-native-image",
            127 => "native-entry-point-missing",
            5 or 577 or 1260 => "native-load-blocked",
            _ => "native-load-failed",
        },
        $"{label}: asset present with matching PE architecture; native win32={error}. " + (error switch
        {
            126 => "Direct VC/UCRT dependency probes loaded; an unresolved dependency or loader-layout problem is still possible. The missing module is not identified.",
            193 => "The main image or a dependency is invalid or has incompatible architecture; the header alone is not a full image check.",
            127 => "A required procedure is missing in the native library or one of its dependencies.",
            5 or 577 or 1260 => "Windows denied the load or rejected its image/policy requirements.",
            _ => "The loader failed; no specific missing dependency has been established.",
        }),
        "Verify the complete official-package output and ask your administrator to inspect Windows/endpoint-policy diagnostics. " +
        "Do not disable security controls, change DLL search paths or copy DLLs from download sites.");

    internal static string ExplainProbeFailure(Exception exception)
    {
        // Type initialization wrappers can hide the actual native loader error.
        for (int depth = 0; depth < 8 && exception.InnerException != null &&
            exception is TypeInitializationException or System.Reflection.TargetInvocationException; depth++)
            exception = exception.InnerException;
        string reason = exception switch
        {
            DllNotFoundException => "native module or dependency unresolved; this exception alone does not identify which DLL is absent",
            BadImageFormatException => "native image or architecture incompatible; compare the PE and process checks",
            EntryPointNotFoundException => "native entry point missing; check package/library compatibility",
            _ => "encoder initialization/encode failed; a missing Windows runtime is not established",
        };
        return $"{exception.GetType().Name} hresult=0x{exception.HResult:X8}; {reason}. " +
            "VP8 unavailable for this probe; consult video preflight and agent/VIDEO-DEPENDENCIES.md. H.264 eligibility is independent.";
    }
}
