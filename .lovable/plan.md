# Repair and independently verify all four Windows release archives

## Confirmed findings

1. **Admin compile failure has a direct cause.** `admin/src/Api/Models.cs` uses `List<SessionFile>` without importing `System.Collections.Generic`.
2. **The later `Copy-Item` error is secondary.** `dotnet publish` fails first, but `admin/build.ps1` does not explicitly stop on the native command's non-zero exit code, so it continues and tries to copy an executable that was never produced.
3. **The two Agent archives are not separate deliverables.** The `2026-08-05g` Agent packaging and Agent source ZIPs each contain the same 47 files with identical bytes. Only their ZIP container metadata/checksum differs.
4. **The two Admin archives are effectively duplicates.** They share 51 byte-identical files; the source ZIP only adds `Native-Video-Engine-B.md`.
5. **Both Windows projects reference a vulnerable dependency.** Agent and Admin use `SIPSorcery 6.2.4`. GHSA-28gm-jrmw-xx93 affects every version through `10.0.8`; the first patched release is `10.0.9`. The current warning is therefore valid even though the JavaScript dependency scan is clean.

## Implementation

### 1. Repair and harden both builds

- Add the missing collections namespace to the Admin API models.
- Add explicit exit-code checks immediately after every `dotnet restore` and `dotnet publish` in both PowerShell build scripts.
- Assert that the expected executable exists before staging it, with a clear diagnostic naming the expected and actually produced files.
- Preserve the standalone signing-helper lookup and unsigned-development fallback already added.

### 2. Remove the vulnerable media dependency

- Upgrade both Agent and Admin to a patched, mutually compatible SIPSorcery/media-encoder set (`SIPSorcery >= 10.0.9`; use the latest stable compatible pair after restore verification).
- Update only API call sites broken by the major-version change.
- Align the VP8 decode spike with the same media package generation so the test harness cannot drift from production.
- Re-scan package restore output and reject any remaining high/critical NuGet advisory.

### 3. Establish four genuinely different deliverables

Create a new milestone with unambiguous names rather than overwriting `2026-08-05g`:

1. **`ConnectLive-Agent-Installer-Builder-2026-08-05h.zip`**  
   Complete release builder: Agent source, assets, Inno/MSI/GPO/Intune/Jamf packaging, signing helper, and installer documentation.
2. **`ConnectLive-Agent-Developer-Source-2026-08-05h.zip`**  
   Developer project: Agent source, assets, signing helper, and a build path for the raw Agent executable; omit installer/MDM packaging.
3. **`ConnectLive-Admin-Release-Builder-2026-08-05h.zip`**  
   Minimal production Admin builder: required source/assets/config, signing helper, install guide, and release build script; omit engineering spikes and design notes.
4. **`ConnectLive-Admin-Developer-Source-2026-08-05h.zip`**  
   Full developer project: production source plus native-video notes and both diagnostic spike projects.

Every ZIP will remain independently buildable from its own extracted root. The source variants will not be relabeled copies of the release-builder variants.

### 4. Clean-extraction verification

For each ZIP independently:

- Extract into a fresh directory with no access to the repository parent.
- Confirm the project, build entry point, signing helper, config/assets, and referenced files all resolve inside that directory.
- Run restore and publish from the extracted root; for the Agent developer archive, build the raw executable without requiring Inno/WiX.
- For the installer-builder archive, verify the raw Agent publish here and validate the Inno/WiX inputs; document that final installer compilation requires those Windows tools.
- Confirm expected output names and ensure a failed compile cannot fall through to misleading copy/package errors.
- Compare normalized manifests and file hashes to prove all four archives are distinct.
- Produce a checksum/manifest report beside the four ZIPs.

### 5. Documentation truth pass

- Update the release checklist with the four-deliverable contract, exact commands, prerequisites, expected outputs, and the correct current Agent route count.
- Add a roadmap audit entry recording the Admin compile fix, fail-fast build behavior, dependency remediation, package split, and clean-extraction results.

## Acceptance criteria

- Admin no longer reports `CS0246` for `List<>`.
- No Agent/Admin restore emits GHSA-28gm-jrmw-xx93 or another high/critical advisory.
- All four new ZIPs have distinct names, manifests, purposes, and checksums.
- Each ZIP can be extracted alone and run its documented build command without relying on `..\tools`, repository-only files, or another archive.
- A publish failure stops at the real error and never continues to a misleading missing-EXE `Copy-Item` failure.
- The four ZIPs plus their SHA-256 manifest are delivered as new downloadable artifacts; the older `g` files remain untouched for traceability.
