# Freshly package the Agent and Admin source-code zips

Got it — you want the **source** zipped, not the compiled `.exe`. Those are
what you carry to a Windows box (or hand to an IT partner) so `agent/build.ps1`
and `admin/build.ps1` can produce the signed installers.

## Readiness check

The roadmap and code are green for a source cut:

- Every in-repo backlog item is CLOSED: **S1, S2, S4, S5, S6, S7, S9, S10,
  S11, S12, S13, S14, S15(a)**.
- The only remaining items — **S3** (Windows fleet rollout), **S8 residual**
  (native-render soak), **S15(b)** (mark two legacy contracts SUPERSEDED) —
  either need a Windows box (which is exactly what the source zip unblocks)
  or are a doc-only cleanup that does not block packaging.
- Installer overhaul (four autostart triggers, `/background` flag) is in place
  in both `agent/packaging/inno/ConnectLiveSetup.iss` and
  `agent/packaging/msi/ConnectLive.wxs`.
- S9 ICE gateway (`/api/public/agent/ice`) is wired to Cloudflare Calls TURN
  and reads credentials from runtime secrets — no source change needed.

Nothing else needs to land before we cut the source zips.

## Optional pre-flight (fast, from here)

Small hygiene that makes the Windows build a single command:

1. Run `tsgo` and the two route verifiers so the source you hand over is known
   green.
2. Close **S15(b)** — mark the two legacy contract docs SUPERSEDED with a
   pointer to `PROJECT-MAP.md`.
3. Add a top-level `RELEASE-CHECKLIST.md` capturing the Windows build steps,
   sha256 capture, and the `public.releases` insert.

Say the word if you want any of these first; otherwise I skip straight to the
zips.

## What I'll produce

Two source zips under `/mnt/documents/` so you can download them directly from
chat:

- `ConnectLive-Agent-source-<date>.zip` — the full `agent/` tree
  (`src/`, `packaging/inno/`, `packaging/msi/`, `assets/`, `build.ps1`,
  `INSTALL.md`, `README.md`). Includes the four-trigger Inno + WiX installers.
- `ConnectLive-Admin-source-<date>.zip` — the full `admin/` tree
  (`src/`, `spikes/`, `assets/`, `build.ps1`, `INSTALL.md`, `README.md`,
  `Native-Video-Engine-B.md`).

Sanitization rules applied to both zips:

- Exclude any build output: `bin/`, `obj/`, `publish/`, `dist/`, `.vs/`,
  `*.user`, `*.suo`.
- Exclude editor cruft: `.DS_Store`, `Thumbs.db`.
- No secrets in the tree today (verified — configs only reference public
  publishable keys and URLs). I'll re-check before zipping.
- Include a short `BUILD-ON-WINDOWS.txt` at the root of each zip listing the
  prerequisites (`.NET 8 SDK`, Inno Setup 6, WiX v4 + Util/Firewall exts) and
  the exact command to run.

Each zip will be surfaced with a `<presentation-artifact>` tag so you can
download it in one click.

## What I will NOT do

- Try to `dotnet publish` from this Linux sandbox — the compiled `.exe` /
  `.msi` still has to come from Windows.
- Bundle any built artifact or half-built binary alongside the source.
- Include the wider web app in these zips — those two trees are the
  Windows-side deliverables; the web/backend already ships from Lovable.

## Decision point

Approve to cut the two source zips as described, or ask me to run the
pre-flight (tsgo + verifiers + S15(b) + `RELEASE-CHECKLIST.md`) first?
