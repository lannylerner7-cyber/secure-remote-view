# Verify recent updates, address the "bypass UAC" ask, and recut all four zips

Two things before packaging:

1. Reconcile the recent Phase 1 (hardware H.264) work against the roadmap and the rest of the codebase so nothing is half-wired.
2. Answer the UAC question honestly — with a design that gets you the same practical outcome without tripping SmartScreen, Defender, or EDR.

Then recut the four release archives (Agent source, Agent build kit, Admin source, Admin build kit) with today's tag `2026-09-08a`, each self-contained and independently buildable.

## About "bypass UAC without a security alert"

We are not going to auto-elevate silently, suppress the consent prompt, hide from SmartScreen, or evade AV. Any of those get the product classified as malware across Defender/EDR and kill the signing cert. That is not an RMM, that is a trojan.

The legitimate way to get "no UAC prompt on end-user machines, survives reboot, sees the secure desktop" — which is what every real enterprise RMM does — is:

- Ship the Agent as a **signed MSI** installed once with admin rights (GPO / Intune / Jamf / a one-time technician install). That is the only UAC moment in the device's lifetime.
- Run the Agent as a **Windows Service under LocalSystem**, auto-start. SYSTEM does not prompt for UAC, survives reboots, and can render on the Winlogon/UAC secure desktop.
- For UI pieces that must live in the user's session (tray, curtain overlay, clipboard), have the service spawn a helper into the active session via `WTSQueryUserToken` + `CreateProcessAsUser`. Still no prompt.
- Keep Authenticode signing (S25); move to an EV cert when volume justifies it so SmartScreen trusts the installer immediately.

The current build is Phase 1 "standalone user-mode Agent." It is fine for the recut today, but the SYSTEM-service model should be a tracked roadmap item — it is the only path that both avoids UAC prompts and stays on the right side of Defender/EDR. This plan records it; it does not implement it in this pass.

## Step 1 — Verify recent updates line up with the roadmap and codebase

Read-only sweep, no edits outside `.lovable/plan.md`:

- Re-read `agent/src/WebRtcSession.cs`, `agent/src/HwH264Encoder.cs`, `agent/src/MediaFoundationInterop.cs`, `agent/src/CodecPolicy.cs`, `agent/src/HwEncoderProbe.cs`.
- Re-read `admin/src/Media/VideoPipeline.cs`, `admin/src/Media/WebRtcClient.cs`, `admin/src/Media/H264Decoder.cs`, `admin/src/Media/MediaFoundationInterop.cs`.
- Confirm the H.264 path is gated by `CodecPolicy.AllowH264` and the `CONNECTLIVE_CODEC=vp8` kill switch, and that VP8 fallback is intact on both sides.
- Confirm `admin/src/ConnectLiveAdmin.csproj` and `agent/src/ConnectLiveAgent.csproj` have `AllowUnsafeBlocks` where the new interop needs it, and that no duplicate `MediaFoundationInterop` symbols leak between namespaces.
- Verify route parity — 25 agent public routes and 5 payment routes — by running the existing `scripts/verify-agent-routes.ts` and `scripts/verify-payment-routes.ts` against `src/shared/api-routes.ts` and `src/routes/api/public/**`.
- Check `PROJECT-MAP.md` and `.lovable/plan/brain-engine-upgrade-rdp-class-streaming-behaviour-2026-09-03.md`: Phase 1 marked done only if verification above holds; Phases 2–6 stay open.
- Grep for hot-linked or duplicated modules that shouldn't ship: stale `ConsentPrompt`, old `AGENT_DEPLOYMENT_KEY`, `ConnectLiveUpdater.exe`, `ConnectLiveService.exe`, any leftover `VideoEncoder` (vs `VpxVideoEncoder`) references, and any `@/hooks/use-toast`/`react-helmet-async` imports.

Anything that fails verification gets listed back to you before packaging — I won't silently "fix" code in plan mode.

## Step 2 — Add the SYSTEM-service track to the roadmap (doc only)

Append a new section to `PROJECT-MAP.md` (and a short new plan file under `.lovable/plan/`) capturing the elevation model above as the next milestone: signed MSI + LocalSystem service + session-launcher helper, replacing HKCU Run self-persistence. No code yet.

## Step 3 — Recut the four zips as `2026-09-08a`

Each archive is self-contained (its own `src/`, `build.ps1`/`build.bat`, `tools/CodeSign.ps1`, `README-BUILD.txt`, `INSTALL.md`) and independently buildable on a clean Windows box with only the .NET 8 SDK (and WiX for the MSI kit):

- `ConnectLive-Agent-Source-2026-09-08a.zip` — `agent/src/`, `agent/assets/`, `agent/build.ps1`, `agent/build-developer.ps1`, `tools/CodeSign.ps1`, `agent/INSTALL.md`, `agent/README.md`.
- `ConnectLive-Agent-BuildKit-2026-09-08a.zip` — same as source plus `agent/packaging/` (msi/inno/gpo/jamf/intune) and a top-level `BUILD-ON-WINDOWS.txt`.
- `ConnectLive-Admin-Source-2026-09-08a.zip` — `admin/src/`, `admin/assets/`, `admin/build.ps1`, `tools/CodeSign.ps1`, `admin/INSTALL.md`, `admin/README.md`.
- `ConnectLive-Admin-BuildKit-2026-09-08a.zip` — same as source plus a `BUILD-ON-WINDOWS.txt`.

Exclusions on every archive: `bin/`, `obj/`, `.vs/`, `*.user`, `publish/`, `dist/`, NuGet caches, `.env*`, anything under `/mnt`.

Before writing the zips: SHA-256 each staged tree, print the digests, and confirm the four archives differ from each other (no accidental duplicates like last time).

## Deliverables

- Verification report in chat: pass/fail for each item in Step 1, with any file:line issues found.
- Updated `PROJECT-MAP.md` + new plan file for the SYSTEM-service milestone.
- Four zips under `/mnt/documents/releases/2026-09-08a/` with SHA-256s printed.

## Out of scope

- Any technique that suppresses UAC, SmartScreen, or AV prompts on end-user machines.
- Implementing the SYSTEM-service model itself (tracked, not built, in this pass).
- Phase 2–6 of the brain-engine upgrade.
