using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;

namespace ConnectLive.Agent;

/// <summary>
/// Bounded, local-only loader inspection. No CWD/PATH search, DLL replacement,
/// process-wide resolver changes, registry edits, elevation or repairs.
/// </summary>
internal sealed class WindowsVp8NativeProbe : IVp8NativeProbe
{
    public bool IsWindows => OperatingSystem.IsWindows();
    public Architecture ProcessArchitecture => RuntimeInformation.ProcessArchitecture;

    public IReadOnlyList<NativeVideoLocation> Locations() =>
        BuildLocations(AppContext.BaseDirectory, AppContext.GetData("NATIVE_DLL_SEARCH_DIRECTORIES") as string);

    internal static IReadOnlyList<NativeVideoLocation> BuildLocations(string appDirectory, string? nativeDirectories)
    {
        var locations = new List<NativeVideoLocation>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(string directory, string label)
        {
            // Do not resolve relative directories against a user-controlled CWD.
            if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory)) return;
            var path = Path.GetFullPath(Path.Combine(directory, Vp8NativeDiagnostics.LibraryName));
            if (seen.Add(path)) locations.Add(new(path, label + "/" + Vp8NativeDiagnostics.LibraryName));
        }
        Add(appDirectory, "app-base");
        // Host-provided locations include a single-file bundle's extraction
        // directory. Do not guess a TEMP subfolder or recursively scan the disk.
        int index = 0;
        foreach (var directory in (nativeDirectories ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            Add(directory, $"host-native[{index++}]");
        return locations;
    }

    public ushort ReadMachine(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new PEReader(stream);
        if (reader.PEHeaders.PEHeader == null ||
            (reader.PEHeaders.CoffHeader.Characteristics & Characteristics.Dll) == 0)
            throw new BadImageFormatException("Expected a Windows DLL.");
        return (ushort)reader.PEHeaders.CoffHeader.Machine;
    }

    public int LoadAsset(string path) => LoadAndRelease(path,
        LoadLibrarySearchDllLoadDir | LoadLibrarySearchSystem32);

    public int LoadDependency(string name, string assetPath)
    {
        // Respect an app-local VC runtime when inspecting that candidate. UCRT
        // API sets are resolved by the Windows loader, never File.Exists.
        if (name == "VCRUNTIME140.dll")
        {
            var local = Path.Combine(Path.GetDirectoryName(assetPath)!, name);
            if (File.Exists(local)) return LoadAsset(local);
        }
        return LoadAndRelease(name, LoadLibrarySearchSystem32);
    }

    private static int LoadAndRelease(string name, uint flags)
    {
        // A fully qualified asset plus these flags restrict dependencies to its
        // directory and System32. Never use LOAD_IGNORE_CODE_AUTHZ_LEVEL.
        IntPtr module = LoadLibraryExW(name, IntPtr.Zero, flags);
        if (module == IntPtr.Zero) return Marshal.GetLastWin32Error();
        try { return 0; }
        finally { FreeLibrary(module); }
    }

    private const uint LoadLibrarySearchDllLoadDir = 0x00000100;
    private const uint LoadLibrarySearchSystem32 = 0x00000800;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr LoadLibraryExW(string name, IntPtr file, uint flags);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(IntPtr module);
}
