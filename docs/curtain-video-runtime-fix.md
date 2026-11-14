# Curtain and video recovery: Agent 1.10.13 source handoff

## Status and scope

Implemented and checked in the workspace on 2026-11-14. This report records the
**pre-push source handoff**, not the current GitHub delivery status.
**Coolify deployment and Windows runtime behavior remain unverified.** No Windows Agent/Admin
binary, installer, or signed release was built. Portable C# test executables
use inert platform adapters; they are not native client builds.

The source-only Agent ZIP contains the full Agent tree and required shared
dependencies, not just changed files. Its manifest records file hashes,
source version, uncommitted-source status and the unverified Windows boundary.
Native Admin, checkout/MainVault, pricing, credentials and database schema
were not changed. Included historical migrations are not new migration work
and should not be reapplied as part of this fix.

## What the supplied logs establish

- Control permission was confirmed before Windows rejected curtain capture
  exclusion, including the attempt at 09:43:14. The old message combined
  setter failure, readback failure and an unexpected affinity value, so it
  does **not** establish an exact Windows error number or driver defect.
- DXGI capture and Intel QSV H.264 initialization/output worked. Encoded-frame
  counters kept increasing through long runs. This is not proof of the
  browser's decoded/presented frame rate or a selected TURN relay.
- JPEG uploads repeatedly exceeded their three-second deadline. Successful
  requests also took roughly 1.5–3 seconds. `server_seen=false` means the
  client did not receive diagnostic response headers; it does not prove the
  server never received or processed that request.
- The heartbeat's mandatory process/authorization work and optional metadata
  writes had large latency spikes. A lost-authority heartbeat intentionally
  stops media and input; silently ignoring it would weaken access control.
- Around 09:52, the peer disconnected, the network address changed, DNS
  requests failed and a heartbeat timed out. Pairing was retained, a fresh
  heartbeat restored viewing, and H.264 output resumed at 09:52:51.
- The Coolify trace is consistent with cancelled HTTP requests being
  represented as framework errors. It does not establish the cause of a
  Windows window API failure, nor prove the whole site crashed.

## Changes

### Curtain

- Use an opaque WPF surface instead of unnecessary per-pixel transparency.
  Retain click-through/no-activation behavior with fully opaque constant
  alpha, and check DWM composition.
- Verify capture exclusion before showing the windows and again after actual
  rendering. Never fall back to a mode that exposes the curtain in capture.
- Return separate rendering, affinity-set/readback, authorization, input-pause
  and lease failure reasons; include a bounded numeric Windows error when
  available. The browser maps only known reason codes to messages.
- Guard delayed activation and queued hide notifications by their generation.
  An obsolete operation cannot acknowledge or hide its replacement.

**This is a compatibility correction, not a claim of a successful Windows
runtime test.** Both the physical display and the technician's unobscured
view must be checked on the affected machine.

### HTTP pressure and cancellation

- Keep one in-flight JPEG upload and one replaceable pending frame. Failed
  uploads wait 0.5, 1, 2, 4, then at most 5 seconds before taking the freshest
  pending frame. Success resets the delay; withdrawal cancels it. Capture and
  WebRTC do not wait for this worker.
- After mandatory native runtime fencing, limit optional metadata writes to
  one second and report failure as a warning. Legacy presence writes keep
  their previous behavior. Device identity, fresh authorization, licensing,
  session checks and runtime ownership remain mandatory.
- Treat confirmed incoming-request cancellation as HTTP 499 rather than
  adding a catastrophic HTML 500 response. Upstream aborts/reset errors on
  live requests and unrelated application errors remain errors. The
  framework may still log its own low-level socket-close messages.

### Video recovery

- A supported, currently authorized view peer can request one keyframe
  before connection replacement, using the existing native encoder cooldown.
- The viewer waits at most four additional seconds after that hint. Only
  actual new decoded/presented frames count as recovery.
- Serialize browser statistics calls, bound a hung statistics read, and avoid
  a statistics-only false disconnection while real presentation advances.
- Preserve codec/route recovery, JPEG permissions, control withdrawal and
  deliberate manual control resume. Do not force an unproven codec or
  promise uninterrupted operation during network/DNS failure.

The 20-second heartbeat deadline, three-second upload deadline, five-second
curtain lease and local stop shortcut remain intact.

## Verification completed

- 138 focused Node test cases across cancellation, heartbeat/frame authority,
  optional telemetry, curtain transactions, signaling, media recovery and
  recovery hints; plus the browser/native protocol script.
- Portable compiler-backed harnesses linked the actual Agent action and
  input-pause partials, curtain controller/lease, latest-work pump and JPEG
  backoff policy. Tested rejection reasons, authorization withdrawal, stale
  activation/release races, lease expiry and nonblocking latest-only work.
- Application TypeScript check and production web build passed. Existing
  framework deprecation/bundling warnings remain.
- Restarted the managed preview and confirmed the public page renders.
  This is not evidence of an authenticated live Windows session.

Representative workspace commands (the GitHub export keeps the app at the
repository root rather than under `imports/connectlive/`):

```text
node --test tests/server-cancellation.cjs tests/bounded-telemetry.cjs tests/agent-http-diagnostics.cjs tests/control-curtain.cjs tests/video-stall-guard.cjs
node --test tests/media-recovery.cjs tests/remote-media-signals.cjs tests/video-transport-recovery.cjs tests/control-recording-contracts.cjs tests/jpeg-diagnostic.cjs tests/jpeg-frame-recovery.cjs
node tests/browser-first-protocol.cjs
dotnet run --project tests/agent-actions/AgentActions.Tests.csproj --configuration Release
dotnet run --project tests/curtain-controller/CurtainController.Tests.csproj --configuration Release
dotnet run --project tests/latest-work-pump/LatestWorkPumpTests.csproj --configuration Release
pnpm --dir imports/connectlive run typecheck
NITRO_PRESET=node-server pnpm --dir imports/connectlive run build
```

## Manual Windows source run

1. Use an authorized test PC with a person at its keyboard and the .NET 8 SDK.
   Stop the older test process; never run both Agents. Follow
   `agent/RUN-SOURCE.md`. Explicit local disable withdraws access and can
   require a new pairing code; do not delete saved credentials to repair a
   transport problem.
2. Extract the complete ZIP into a fresh directory. From PowerShell:

   ```powershell
   cd .\agent
   Unblock-File .\run.ps1
   .\run.ps1
   ```

   The script builds/runs the source **on your Windows machine**, not here.
   Confirm the startup log says **1.10.13**. Add `-Pair` only when a new pairing
   is actually needed; use the documented server-origin option if necessary.
   Do not run installer/build scripts for this acceptance check.
3. `.\run.ps1 -Logs` only opens the log folder; it does not build or start
   the Agent. Logs normally live in `%LOCALAPPDATA%\ConnectLive\logs`.
4. Use **Take control + curtain**. Confirm the physical notice appears on
   every intended display, the technician still sees the desktop, and control
   is not enabled until the Agent acknowledges success. Check Release and
   the local stop shortcut with the person at the keyboard.
5. If rejected, capture the short `curtain display rejected` / `curtain
   request rejected` section, including `reason` and `native_error`. The old
   generic message alone cannot establish the remaining Windows API cause.

The Agent-side rendering/backoff changes are compatible with the current
protocol. Browser messages, keyframe-request initiation and the optional
heartbeat-write deadline require the matching **web/server deployment**.
The ZIP does not publish that deployment. Production latency improvements,
Windows rendering/input behavior and longer real-network soak tests remain
unverified.
