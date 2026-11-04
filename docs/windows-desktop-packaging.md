# Windows desktop ZIP verification — 2026-10-22

## Latest rebuild: Agent 1.10.1 / Admin 1.7.3 — 2026-11-03

New outputs are in ignored
`generated-artifacts/windows-clients-20261103-v2-agent-1.10.1-admin-1.7.3/`.
Built from a fresh source snapshot at workspace commit `db5a406`, matching
GitHub `main` (`a9ed954`, the merged ScreenConnect-inspired Access update).

- Agent ZIP `ConnectLive-Agent-1.10.1-Windows-x64-20261103.zip` (139,446,677 bytes)
  SHA256: `908899b1130b6351d30c9a89d31e230ea2a79d8627655e1ebc5aa392bb56f345`
- Admin ZIP `ConnectLive-Admin-1.7.3-Windows-x64-20261103.zip` (79,770,992 bytes)
  SHA256: `863c8fe7c0adb11ea366ad7aa1e015d84daa7deb493faf0822cb46d9179667c6`
- Native source SHA256: `0ae9865484a9b733376417c9019368654df1da79690b49d452a7227d8dcb096b`

Unlike the 1.9.2/1.7.3 archives, the Agent ZIP now also carries the runtime
companion executables `ConnectLiveWatch.exe` and `ConnectLiveUpdate.exe`
(self-contained, alongside `ConnectLive.exe`), which the Agent expects for its
authorized recovery/update flows. All four executables were published fresh
(no reused bin/obj), PE x64-checked, and archive CRC + per-member SHA256
verified. An earlier same-day output directory was discarded untrusted and is
not release evidence. These remain unsigned portable verification builds:
no Windows runtime, pairing, capture, input, reconnect, startup-recovery or
update claim is made.

## Previous rebuild: Agent 1.9.2 / Admin 1.7.3

New outputs are in ignored `generated-artifacts/windows-desktop-agent-1.9.2-admin-1.7.3/`.
The older ZIPs below were preserved and their hashes rechecked unchanged.

- Agent ZIP SHA256: `58dc1aebdd6cb6ffa7040fadec1b4db34e3f5a089359faa6a972b67aed0667d9`
- Admin ZIP SHA256: `8e090b3620de5f57ae8b4598b84c762347533749735d591ef3a73c41056ff49a`
- Native source fingerprint: `54fb3b4c6d86d18f273edba39c6138ecdc4f12b8b19689ca66d7e510cd70fa66`.

Both projects published from a new source snapshot without existing bin/obj.
SOURCE.json records baseline commit and per-source-file hashes; the baseline is
explicitly NOT claimed as a pushed release commit. The content fingerprint is
also embedded in the assembly informational version.

The Agent now creates its configuration directory before writing, uses an
atomic file replacement, and handles startup configuration failures through
its existing startup error handling rather than writing before initialization.
Permission, enrollment and local-stop behavior were not expanded.

Verification passed: new config persistence regression checks, 22 native gateway
checks, 14 local access checks, 54 grant checks, both clean Windows x64 builds,
public Supabase key/project zero-row request, PE architecture, ZIP CRCs and
per-member SHA256. Builds retain CS1998, CS8602 and WFAC010 warnings; this is not a
warning-free or Windows-runtime-verified release.

GitHub SSH access is now verified using a user-authorized repository deploy key.
Source updates target the review branch `replit/connectlive-source-update`, not
the production branch. Native source hashes in the export match these ZIPs.
The post-push verification record is saved separately as
`generated-artifacts/github-push-manifest.json`; the ZIP metadata reflects its
original, pre-push build time. No deployment or release-record update is included.
The reviewed native compatibility issues in `docs/review/README.md` remain
release blockers. These unsigned portable ZIPs are for Windows verification.

## Previous delivery evidence (not rerun unless noted above)

## Outputs

Under ignored `generated-artifacts/windows-desktop/`:

- `ConnectLive-Agent-Windows-x64.zip` — Agent 1.9.1; run Start-Agent.cmd.
- `ConnectLive-Admin-Windows-x64.zip` — Admin 1.7.2; run ConnectLiveAdmin.exe.
- `release-manifest.json` — archive byte sizes, SHA256 and explicit unsigned/runtime-unverified flags.

Both ZIPs contain a top-level folder, the self-contained Windows x64 executable,
instructions and per-file SHA256SUMS.txt. Agent includes an explicit production
launch command; Admin includes its public Supabase configuration.
Extract the whole archive first. Windows 10 version 2004 or newer / Windows 11.
No separate .NET install is required.

These are portable desktop verification builds, not MSI/Inno installers.
They do not install a watchdog service or startup task. No signing credentials
were used; Windows publisher/reputation warnings may appear. Do not disable
security tools; follow organizational approval policy.

## Build and archive evidence

Published the two explicit main csproj projects in Release with win-x64,
self-contained=true, PublishSingleFile=true and EnableWindowsTargeting=true.
Both publish commands completed with new executable outputs; existing async,
nullable and DPI warnings remain. Both files parse as x64 Windows GUI PE files.

`scripts/package-windows-desktop.py` validates the public key (never accepts a
service-role JWT), validates a zero-row request against the intended Supabase
project, configures only the generated Admin output, requires an exact file
allowlist, omits PDBs, and checks ZIP CRC plus extracted-content hashes.
All archive checks passed. Required public configuration is provided from the
existing VITE_SUPABASE_PUBLISHABLE_KEY environment variable without logging it.
No account password, SMTP credential, TURN token or service-role key is bundled.

Current verification also passed 16 gateway tests, 17 actual-code browser ICE
scenarios and 22 portable native policy/transport checks. Public production
health returned 200 with `OK`; anonymous production ICE returned 401.
These two HTTP checks do not establish which backend revision is deployed.

## Reproduce

Use a NEW output directory on each invocation. The build script copies native
sources without compiler intermediates, records source hashes and publishes the
two explicit projects. The packaging script refuses to replace existing ZIPs.

    python scripts/build-windows-desktop.py --output generated-artifacts/windows-desktop-next
    python scripts/package-windows-desktop.py --output generated-artifacts/windows-desktop-next

Never place the generated public configuration or private environment files
into source control. The source Admin config remains a template.

## Still requires Windows

Neither executable was launched on this Linux host. Desktop sign-in,
enrollment, DXGI capture, actual TURN allocation, first-frame performance,
control, stop/revocation, takeover and long-session reconnect require two
authorized Windows devices. The included README gives the verification sequence.
No real remote session was started, no grant was bypassed, and no production
rollout or release-database publication occurred.
