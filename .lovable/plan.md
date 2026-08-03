# Readiness check + packaging the fresh Agent / Admin zips

## Short answer

The codebase itself is release-ready. The roadmap MD confirms every backlog item
that lives inside this repo is CLOSED: **S1, S2, S4, S5, S6, S7, S9, S10, S11,
S12, S13, S14, S15(a)**. The only items still marked incomplete are the two
that cannot be closed from a Lovable sandbox:

- **S3** — fleet rollout of the freshly built agent (requires an actual Windows
  install on real machines).
- **S8 (residual)** — sustained-motion native-render soak; unblocks after S3.
- **S15(b)** — mark the two legacy contract docs SUPERSEDED (pure doc turn).

None of those block cutting a new zip. What *does* block cutting the zip from
here is toolchain, not code — see the next section.

## Why the zips cannot be produced inside this sandbox

The Agent and Admin are .NET 8 WPF single-file Windows executables. The build
pipeline is Windows-only by construction:

- `agent/build.ps1` and `admin/build.ps1` are PowerShell and call
  `dotnet publish -r win-x64 --self-contained -p:PublishSingleFile=true`.
- The Agent installer (`agent/packaging/inno/ConnectLiveSetup.iss`) is
  compiled with **Inno Setup 6** (`iscc.exe`, Windows-only).
- The MSI (`agent/packaging/msi/ConnectLive.wxs`) is compiled with
  **WiX v4** plus the `Util` and `Firewall` extensions.
- The Lovable sandbox is Linux and has **no .NET SDK, no PowerShell, no Inno,
  no WiX** available, and installing them here would not produce a signed,
  Windows-tested artifact.

Even a cross-published `dotnet publish -r win-x64` from Linux (if the SDK were
present) would skip the installer step entirely, produce an unsigned exe, and
never touch the four autostart triggers the roadmap requires — so it would not
be the "freshly sanitized" bundle you asked for.

## What to do to actually cut the zips

Run the existing scripts on a Windows box with the prerequisites listed in
`agent/build.ps1` and `admin/build.ps1`:

1. On a Windows 10/11 x64 machine with:
   - .NET 8 SDK
   - Inno Setup 6 (`iscc` on PATH)
   - WiX v4 (`dotnet tool install --global wix` + `Util` and `Firewall`
     extensions)
2. From the repo root run `build.bat` (the one-click wrapper) for the raw
   `ConnectLive.exe` + `ConnectLiveAdmin.exe` zips, then run
   `agent\build.ps1` to additionally produce
   `dist\ConnectLiveSetup.exe` and `dist\ConnectLiveAgent.msi` (both carry the
   four autostart triggers from the S9 installer overhaul).
3. Optionally sign each `.exe` / `.msi` with your code-signing cert.
4. Publish the release rows so S14 auto-update wakes up:
   ```sql
   insert into public.releases
     (product, channel, version, download_url, sha256, notes, mandatory, published, published_at)
   values
     ('agent', 'stable', '<version>', '<url>', '<sha256>', '<notes>', false, true, now()),
     ('admin', 'stable', '<version>', '<url>', '<sha256>', '<notes>', false, true, now());
   ```

## Pre-flight I can (and will, if you approve) do from here first

Small hygiene items so the Windows build is guaranteed clean on the first try:

1. **Verify contracts and TS build are clean** — run `tsgo` and the route
   verifiers (`scripts/verify-agent-routes.ts`, `scripts/verify-payment-routes.ts`)
   and record the results as an audit row in `PROJECT-MAP.md`.
2. **Close S15(b) doc drift** — mark the two legacy contract docs SUPERSEDED
   with a pointer to `PROJECT-MAP.md`, per the roadmap's own remedy.
3. **Bump versions deliberately** — set `<Version>` in
   `agent/src/ConnectLiveAgent.csproj` and `admin/src/ConnectLiveAdmin.csproj`
   to the next release number so the MSI `MajorUpgrade` and the S14 self-update
   manifest see a clean bump (rather than the auto date-stamp).
4. **Add a `RELEASE-CHECKLIST.md`** at the repo root capturing the Windows
   build steps above, sha256 capture, and the `releases` insert — so the next
   cut is a single command list for whoever runs the Windows box.

## What I will NOT do from here

- Attempt to `dotnet publish` on Linux and hand you a mislabelled "release" zip.
- Silently skip Inno / WiX and ship only the raw exe.
- Publish `releases` rows without real sha256 values from a real Windows build.

## Decision points for you

- Approve the pre-flight (items 1–4 above)? If yes, I run them, then hand off
  to the Windows machine for the actual `build.ps1` run.
- Or skip straight to the Windows build and only do (3) — the version bump —
  from here first?
