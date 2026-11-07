# Windows video dependency preflight

This is source-only diagnostic work. No Windows Agent/Admin build, native
execution, installer, device connection or dependency installation was performed
in the workspace. The user builds and runs the source on a designated Windows
test machine. An existing successful pairing does not need to be repeated.

## What the uploaded log does and does not prove

The log reports an Intel hardware H.264 Media Foundation Transform (MFT), then a
VP8 `DllNotFoundException` for `vpxmd` **or one of its dependencies**, Windows
error `0x8007007E` (126). That establishes a loader failure, not which file is
missing. It does not prove the Visual C++ runtime is missing, and it does not
prove H.264 actually initialized or produced frames. The former probe-cleanup
exception is already contained; containing it does not install dependencies.

The new checks report this distinction **before a session arrives**. They are
informational, not a startup blocker or a replacement codec-selection policy.
Each peer still exercises VP8 with an actual synthetic encode before offering
it. H.264 eligibility remains independent of VP8. A working native loader is
not proof of a successful encode, and a 16×16 synthetic encode is not proof of
encoding at desktop resolution or of negotiation, transport or display.

## Verified requirements of the exact package

Authoritative package inspected: **SIPSorceryMedia.Encoders 10.0.4** from the
[official NuGet flat-container archive][package], not a DLL-download website
and not an assumption based on the current upstream project file.

| Item | Evidence in the 10.0.4 archive |
| --- | --- |
| Managed assemblies | `lib/netstandard2.0/SIPSorceryMedia.Encoders.dll` (ZIP entry has a doubled slash) and `lib/net461/SIPSorceryMedia.Encoders.dll` |
| Declared NuGet dependency | `SIPSorceryMedia.Abstractions` **8.0.12**; this is not a Windows VC-runtime installer |
| x64 VP8 native asset | `build/x64/vpxmd.dll`, 1,742,848 bytes, PE AMD64 `0x8664` |
| x86 VP8 native asset | `build/x86/vpxmd.dll`, 1,533,440 bytes, PE I386 `0x014c` |
| ARM64 native asset | **Not present** |
| Native copying | `build/SIPSorceryMedia.Encoders.targets` selects **x86 for `Platform=x86`**, **x64 for `Platform=x64` or `AnyCPU`**; copies `vpxmd.dll` to the output root using `ContentWithTargetPath`, `CopyToOutputDirectory=Always` |
| What does not select the native asset | `RuntimeIdentifier` alone; this package does not use `runtimes/win-*/native` assets |
| Agent default | `RuntimeIdentifier=win-x64`; normal `AnyCPU` package selection supplies the x64 native DLL |

Both supplied DLLs directly import exactly:

```text
KERNEL32.dll
VCRUNTIME140.dll
api-ms-win-crt-utility-l1-1-0.dll
api-ms-win-crt-convert-l1-1-0.dll
api-ms-win-crt-heap-l1-1-0.dll
api-ms-win-crt-runtime-l1-1-0.dll
api-ms-win-crt-stdio-l1-1-0.dll
api-ms-win-crt-math-l1-1-0.dll
```

The PE import tables establish:

- **Microsoft Visual C++ v14 runtime**, specifically `VCRUNTIME140.dll`,
  matching the **running process architecture**. For this win-x64 Agent,
  use Microsoft's supported **x64** Redistributable installer or approved
  repair procedure from the [official Microsoft page][redist]. A .NET 8 SDK
  or runtime installation alone is not evidence this dependency is satisfied.
- **Windows Universal CRT**, through the six API-set contracts above.
  Microsoft documents UCRT as an OS component on Windows 10/11; use approved
  Windows servicing/repair if these cannot load. API-set names are loader
  contracts and need not exist as individual physical DLLs to be usable.
- `KERNEL32.dll` is a Windows system component, not a file to acquire from a
  codec website.
- No OpenH264 DLL, `MSVCP140.dll`, `VCRUNTIME140_1.dll`, or VC-runtime installer
  is shipped in this archive or directly imported by these two DLLs.
  This is not a claim about all transitive dependencies of Windows components.
- The package does **not** declare a minimum VC-runtime patch version. Both
  DLLs report linker version 14.26, but that is not a sufficient minimum-runtime
  version contract. Follow Microsoft's supported v14 guidance; do not invent a
  requirement for VC++ 2013 or promise that any arbitrary v14 build will work.

Do not download replacement DLLs, copy random system files beside the Agent,
relax folder permissions, disable endpoint protection, or change the system DLL
search path to make the error disappear. The preflight does none of these.

### Reproducible package evidence

SHA-256 digests of the inspected official bytes:

```text
archive:
c6c80f2eb5268bd93bb7d0f1e176e01c7f0d31fac5e96e499fdab4c91023ebdd
build/x64/vpxmd.dll:
9ef05f9448c23de0043c1b9da7d84fd3bc07d3a7aaeb57ce87ca68a52b8622c7
build/x86/vpxmd.dll:
7fd9cc7cd8c98347e92daa4ec76274160731ec9075885a67fbd7ebf93176f1c6
```

These are provenance/reference digests, not an automatic allowlist or a claim
that a customer machine has these files. Archive listing, nuspec/targets
inspection and non-executing `objdump -p` of each DLL supplied the evidence.
No DLL from that inspection is part of a source delivery. Re-audit these facts
if the encoder package changes.

Additional authoritative references:

- [NuGet version page][nuget] and [exact nuspec][nuspec].
- [Upstream native build instructions][upstream] mention VS16 targets.
  This repository reference is supplemental; the released archive is the
  authority for the shipped assets.
- [Microsoft Visual C++ Redistributable architecture/version guidance][redist].
- [Microsoft Universal CRT deployment][ucrt].
- [Microsoft LoadLibraryExW search restrictions][loader].
- [.NET single-file native-library/extraction guidance][single-file].

## Running the checks yourself

Normal startup runs the preflight after local authorization, before enrollment
recovery and sessions. It does not capture the desktop or make network requests.
To run **only the local checks**, without pairing, enrollment, startup
registration, session restoration or any remote connection, from `agent`:

```powershell
dotnet run --project .\src\ConnectLiveAgent.csproj -- --video-preflight
```

That command builds locally on **your Windows machine**, then exits after
writing diagnostics. For an already built copy:

```powershell
.\ConnectLive.exe --video-preflight
```

The diagnostic process's zero exit code means the checks completed, **not**
that all codecs are available. Read the recorded states. Do not use
`build.ps1` for this check: it is the installer pipeline.

Open logs using `.\run.ps1 -Logs` or
`%LOCALAPPDATA%\ConnectLive\logs\agent-YYYYMMDD.log` under the Windows account
that launched it. A fallback log can be under `%TEMP%\ConnectLive\logs`.
New dependency messages use labels like `app-base/vpxmd.dll` and
`host-native[0]/vpxmd.dll`, not private full paths or raw exception messages.

### Interpreting states and taking safe action

| Logged state | Meaning and action |
| --- | --- |
| `missing-native-asset` | Not found in the app directory or host-provided native directories. Restore the official NuGet package and rebuild the **complete** output in a fresh directory; do not move only the EXE. Custom loader locations were not searched. |
| `architecture-mismatch` | A candidate DLL's PE machine does not match the process. Align project platform, process and native asset; normal Agent build is win-x64. OS architecture alone is not enough, including x64 emulation on ARM64 Windows. |
| `unsupported-process-architecture` | Package supplies x86/x64, not native ARM64. Use the supported Agent build; do not relabel an x64 DLL as ARM64. |
| `invalid-native-image` | Candidate is not a readable PE DLL; restore a fresh complete output from the approved source/package. |
| `runtime-dependency-unavailable` | Native asset exists and matches the process, but loading failed with 126; separately named VC/UCRT loader probes also failed. Codes identify failed checks, not a definitive missing-vs-blocked diagnosis. Follow the corresponding Microsoft repair guidance. |
| `bad-native-image` | Loader error 193 despite a matching header. The DLL **or a dependency** may be wrong-architecture, corrupt or incompatible. |
| `native-entry-point-missing` | Loader error 127; incompatible/missing procedure in an image or dependency. Restore a consistent approved package/runtime. |
| `native-load-blocked` | Windows error 5, 577 or 1260. Have the administrator inspect image validation and endpoint-policy diagnostics. Do not bypass them. |
| `native-load-failed` | Other loader error, or 126 with direct runtime probes passing. The cause remains unresolved; do not assert a missing VC runtime. |
| `inspection-incomplete` | File access/inspection failed. This is not evidence that a file is absent. |
| `native-load-ok` | That candidate loaded with restricted search paths, then the handle was released. This does not set a resolver or prove the package's own DllImport selects that candidate. |
| `VP8=synthetic-encode-ok` | The actual managed encoder produced nonempty output for synthetic 16×16 pixels. No live resolution, connection or decoder is verified. |
| `VP8=unavailable` | The actual synthetic encode failed or produced no bytes. VP8 will not be offered unless a later per-peer probe succeeds. |

Checks inspect only the app directory and `.NET`'s
`NATIVE_DLL_SEARCH_DIRECTORIES`, which may include single-file extraction.
They never recursively scan TEMP, search PATH/current-working-directory, or
modify the package's resolver. A missing loose sidecar alone does not prove a
single-file build omitted the native asset. This package ships native DLLs as
MSBuild content; its actual publish/extraction layout still needs a Windows
check. Do not assume `IncludeNativeLibrariesForSelfExtract` installs VC++ or
guarantees third-party content was bundled correctly.

For each matching candidate, `LoadLibraryExW` is limited to the DLL's directory
and System32. Failed runtime checks use an app-local `VCRUNTIME140.dll` when
present, otherwise System32. Universal CRT API sets are queried through the
loader. The actual managed encoder probe remains authoritative for VP8; the
restricted diagnostic lookup can differ from a custom runtime search setup.
The log preserves both findings rather than turning inventory into a codec gate.

Hardware H.264 uses **Windows Media Foundation**, not `vpxmd` or a software
OpenH264 library from this package. Missing Media Foundation (for example,
Windows N/KN media features) and GPU-driver problems are separate from VP8.
Discovery, preference, offer, negotiation, initialization and encoded frames
are separately described. A hardware candidate alone cannot certify video.
An unavailable VP8 path must not suppress that independent H.264 candidate.
`CONNECTLIVE_CODEC=vp8` still explicitly prevents offering H.264.

JPEG fallback remains limited to already authorized JPEG-enabled sessions.
No preflight changes media permissions, heartbeat/dead-man timeouts, device
enrollment or session-disconnection handling.

## Verification and remaining Windows checks

Portable tests can be run without building the Windows Agent:

```text
dotnet run --project agent/tests/video-preflight/VideoPreflight.Tests.csproj
node tests/video-native-preflight.cjs
```

In the repository, prefix the first path with `imports/connectlive/`.
These exercise real diagnostic classification, location selection, PE parsing,
startup idempotence and the VP8 wrapper's cleanup boundary. Native loads and
encoder output are **test doubles**. They do not execute Windows codec DLLs.

The designated Windows manual validation still needs:

1. Confirm fresh-source build output and an offline preflight log, including
   process architecture and both codec findings. Do not re-pair a working device
   merely to investigate the native error.
2. In disposable test outputs/environments only, check missing asset, wrong
   architecture and absent VC-runtime cases. Do not remove system files or
   uninstall shared runtimes on a customer machine to manufacture a failure.
3. Verify both ordinary folder and intended single-file output layouts,
   including native extraction under the real launch account.
4. In an explicitly authorized test session, prove actual H.264 initialization
   and increasing encoded/decoded frames while VP8 is unavailable; separately
   prove a VP8-only offer is not falsely reported usable.
5. After an approved runtime repair and Agent restart, prove actual VP8 frames.
   Keep JPEG/HTTPS success and session-upload stalls as separate evidence.

[package]: https://api.nuget.org/v3-flatcontainer/sipsorcerymedia.encoders/10.0.4/sipsorcerymedia.encoders.10.0.4.nupkg
[nuget]: https://www.nuget.org/packages/SIPSorceryMedia.Encoders/10.0.4
[nuspec]: https://api.nuget.org/v3-flatcontainer/sipsorcerymedia.encoders/10.0.4/sipsorcerymedia.encoders.nuspec
[upstream]: https://github.com/sipsorcery-org/SIPSorceryMedia.Encoders/blob/f9d98a04452a690a0e295b8482cc653adc997896/lib/libvpx_build_steps.txt
[redist]: https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist
[ucrt]: https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment
[loader]: https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw
[single-file]: https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview
