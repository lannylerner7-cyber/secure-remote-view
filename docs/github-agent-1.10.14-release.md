# GitHub delivery: Agent 1.10.14 source and the viewer help popup

Date: 2026-11-15.

- Repository: https://github.com/lannylerner7-cyber/secure-remote-view
- Branch: `main`, updated with a normal (non-force) push on top of
  `6d62e5f6c177164d48e757bbb25933cd8e939b50`.

This file is part of the update it describes, so it cannot contain its own
commit hash. To find it, run
`git log -1 --format=%H -- docs/github-agent-1.10.14-release.md`.

## What the update contains

1. **Agent 1.10.14 source** with the curtain display repair. The Agent,
   shared and tool source in the repository matches the delivered
   `ConnectLive-Agent-1.10.14-Source.zip` byte-for-byte (134 files; archive
   SHA256 `6ba4d20e63dc8daa8dc9f7026928774c96dc4f63c84eced84fa8f0c510c4488b`).
   Details: `docs/agent-1.10.14-curtain-source-release.md` and
   `docs/curtain-display-repair.md`.
2. **Web viewer help popup.** The permanent amber notice above the live
   viewer ("Automatic JPEG fallback enabled…", video state, log path) is
   removed. A **?** button beside the session status line opens a popup with
   the same live information as a short explanation. The button turns amber
   when live video is not being shown. Recovery and JPEG fallback behavior
   are unchanged; this is a presentation change only.
3. **Tests and documents** for both.
4. **Three dependency entries put back** (separate commit, see below).

## Dependency entries put back, and why

`main` at `6d62e5f` no longer listed `three`, `@types/three` and
`@replit/connectors-sdk` in `package.json`, but the application still imports
them:

- `src/components/site/session-core.tsx`, `src/components/site/guide/guide-scene.tsx`
  and `src/components/site/guide/guide-stage-engine.ts` import `three`
  (homepage 3D guide).
- `src/lib/guide-speech-provider.server.ts` imports `@replit/connectors-sdk`.

An unmodified checkout of `6d62e5f` was tested with a clean package cache
before anything was changed: the frozen install succeeded, then the type
check failed and the production build stopped with
`Rolldown failed to resolve import "three"`. Nothing pushed on top of that
tree could have been built or deployed.

Only the removed entries were restored, taken from the last published
revision that built (`d25e12faeb68678632ad60dea76bb7ca2653c563`): three lines
in `package.json` and the matching twelve lines in `bun.lock` (the three
packages and their six transitive packages, same versions and integrity
hashes as before). The newer `@lovable.dev/vite-tanstack-config` 2.27.1 and
every other upstream line are kept. No package was upgraded or added beyond
that.

**If these entries are removed again, the build fails again.** The restore
is its own commit so it can be reviewed or reverted separately.

## Checks on the exact app-at-root export

Run with synthetic public configuration and no application secrets:

- Clean-cache `bun install --frozen-lockfile`: 462 packages. Lockfile package
  hosts are public, credential-free HTTPS.
- TypeScript check and Node-server production build: passed.
- The built server answered `/health`, `/` and `/connectlive/admin` with 200.
- Focused Node regression tests: 161 passed, none failed or skipped
  (includes the new help-popup and updated JPEG-diagnostic tests).
- Session tools UI, console access (51) and browser/native protocol checks:
  passed.
- Six portable C# harnesses passed: curtain display (41), curtain controller
  (24), Agent actions, grants, input pause, latest-work pump. They link
  production Agent code with inert platform adapters and are **not** Windows
  evidence.
- Staged files equal the explicit allowlist; whitespace, private-path and
  credential-signature checks passed. This is not a full security scan.
- All 759 other upstream tracked files are byte-identical, including
  checkout, payment, invoice, pricing and database files, the native Admin
  source, the new `previewAuthStorage.ts` and the generated route tree.

In the workspace preview (not production), a signed-in viewer check confirmed
the old notice is gone and the **?** popup opens and closes by mouse and
keyboard, inside the viewer, in fullscreen and on a 390px-wide screen. That
check ran without live video; the popup's live-video wording is covered by
unit tests only.

## Remaining boundaries

- **Agent 1.10.14 has not been built or run on Windows.** No executable,
  installer or MSI was produced. The curtain acceptance table in
  `docs/agent-1.10.14-curtain-source-release.md` is still to be run by the
  owner on an authorized test PC.
- No deployment was triggered manually and no Coolify setting was changed.
  Existing automation may react to the push; whether it did, and how the
  production site behaves afterwards, was not verified.
- No installed Agent is updated by a Git push.
