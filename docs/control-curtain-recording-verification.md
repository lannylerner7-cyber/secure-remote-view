# Control, curtain and recording — verification and Windows handoff

## Status and scope

- Current source: **Windows Agent 1.10.10**, **Windows Admin 1.7.4**, and the
  repaired web Admin/gateway in this workspace.
- At the original source handoff, these changes had not been pushed or deployed.
  A subsequent GitHub source push does **not** establish a successful Coolify
  deployment. The published site's serving commit/assets remain unverified. Diagnostic
  protocol 2 in the supplied log is not a Git revision.
- No Windows application, executable or installer was built here. Only portable
  C# helpers were compiled and exercised on Linux.
- Physical Windows curtain placement, capture exclusion, local input blocking,
  emergency escape and sustained native recording remain **pending manual
  acceptance** on the explicitly designated test machine.
- Checkout, MainVault, pricing, schema and hosting infrastructure were not changed.
  SQL files in source archives are existing reference material; **do not apply
  migrations for this repair**.

## What the original evidence establishes

The supplied Agent 1.10.9 log uses the production origin. It shows negotiated
H.264, open command channels, and 239 encoded frames, with the measured positive
samples averaging about 1.94 frames/second. That proves Agent encoding, not
matching browser/native presentation or a playable saved recording.

A 17.302-second heartbeat precedes the recorded control-mode transition. The
browser control operation had a 15-second total deadline. This makes a late
permission acknowledgement a credible failure mechanism, but there was no
same-session Admin click timeline or curtain application receipt to prove that
it caused this specific attempt.

The Windows Admin refused H.264 because its recorder accepted VP8/IVF only,
then incorrectly suggested checking disk permissions. The browser could select
MP4 but always used a WebM filename. Both were direct source-level mismatches.

## Cross-client contract

| Operation | Browser Admin | Windows Admin | Agent/gateway acceptance |
|---|---|---|---|
| Mode mutation | Active session + exact grant + current `admin_client_id`; confirmed row returned | Active session + current `admin_client_id`; confirmed row returned | A mode write alone is not application proof |
| Controller identity | Stable `web-…` or page-stable fallback; 8–64 permitted routing characters | Persistent native client ID | Controller IDs are **not UUID-only**; must equal the session's current binding |
| Permission refresh | `permission_refresh` on current `input` channel | Same command, no delayed REST queue | Payload: `request_id`, `mode`, `authorization_id`; current peer and saved grant must match |
| Fresh mode read | Waits for correlated Agent receipt | Same; updated Agent required | Device-authenticated `GET /api/public/agent/session/{id}/permission`; checks active session, grant, controller, running process instance, license, and fresh capability RPC |
| Permission receipt | `permission_status` with matching session/grant/request, `status: applied`, expected mode | Same | `permission_refresh_supported: true`; mode read does not establish/extend heartbeat authority |
| Curtain application | `curtain_on` with unique request ID | Same | Receipt emitted after the native rendered/apply callback, not when work is merely queued |
| Curtain receipt | `action_status`, matching session/grant/request/action, `status: applied`, `active: true` | Same modern receipt for initial application/release | Preserves request ID spelling: native GUID `N`, browser GUID `D` |
| Renewal | `curtain_renew` | `curtain_renew`, not repeated activation | Five-second lease unchanged; renew cannot activate an inactive curtain |
| Legacy receipt | Not used as application proof | Echoed `curtain_status` remains usable for heartbeat confirmation | `sent_at` is the Admin's echoed monotonic timestamp; freshness is measured on that same Admin clock |
| Release | Immediate current-peer release + guarded view write | Current-peer release, independent REST safety fallback, guarded view write | Immediately narrows receiver mode; physical release receipt is distinct from a queued fallback |
| Cancellation / old replies | Correlated pending request removed; view rollback | Same; channel replacement cancels pending operations | Revoked peer cannot revive; older heartbeat observations cannot overwrite newer permission reads/releases |
| Recording authority | Fresh gateway proof; three-second request budget | Fresh authorized recording RPC | Five-second non-revivable lease; no grant caching across requests |
| Recording output | Actual MediaRecorder MIME decides `.webm` or `.mp4` | H.264 → `.mkv`; VP8 → `.ivf` | Actual received/decoded video only; no substitute desktop-capture path |
| Stop / interruption | Await final chunk; two-second finalization bound; one shared finalizer | Finalize a nonempty decodable segment and expose its path/error | No automatic recording or curtain restart after recovery |

### Ordering and safety details

1. The explicit combined action changes server mode, obtains current Agent
   permission, then waits for curtain application before enabling ordinary input.
2. The targeted mode read avoids the telemetry-heavy heartbeat. A request-start
   ordering guard prevents a slower, older heartbeat response from undoing it.
3. Bare safety release still works. Repeated activation IDs cannot re-enable an
   expired/released curtain, including from an older native Admin.
4. A failed mandatory heartbeat authority/process-fence check still stops the
   live transport immediately. The misleading second “three failures” teardown
   branch was removed; enrollment is retained for later authorized recovery.
5. Heartbeat grant/license/session reads overlap independent work. Metadata
   write failure is a reporting warning, not remote-session authority. Runtime
   fencing, actual authorization, licensing and required session operations still
   fail closed.
6. Recording authorization reuses the immutable, exact bound grant and performs
   fresh final view/control checks. The common recording response uses two
   capability RPCs instead of seven; capability changes revoke the old grant ID.
7. Renewal reserves the existing three-second verification budget **inside**
   the five-second lease. It does not wait an extra fixed two seconds after a
   slow response and does not extend the safety lifetime.
8. Secure-screen recording exclusion remains in place. A browser recorder whose
   stop was not confirmed requires reopening the viewer before Windows unlock.

## Native recording behavior

- The H.264 writer stores Annex-B access units as AVC samples in Matroska. It
  records SPS/PPS codec information, starts at an IDR, uses monotonic timestamps,
  and writes the final duration. It does not invoke FFmpeg or an encoder at
  application runtime.
- Codec headers are remembered separately from footage, so starting recording
  mid-session also works when an encoder does not repeat SPS/PPS on every IDR.
- Empty files and leading undecodable interframes are not reported as saved.
- A changed codec configuration stops the segment with an explicit message.
  Start a new recording after the new video configuration settles. This avoids
  silently corrupting the existing track.
- File creation, write/finalization, permission and video-readiness failures
  have different messages. A valid authorized prefix can be retained on a
  native interruption; the actual saved path is shown.

## Checks completed

- Imported web app: `pnpm --dir imports/connectlive run typecheck`.
- 73 Node contract/regression cases across control coordination, receipt
  correlation, fresh permission API, recording authorization, heartbeat
  diagnostics and existing browser protocol behavior.
- Browser recording component tests with **mocked** media/transport APIs:
  denial, expiry, revocation, correct MP4 MIME fallback, asynchronous encoder
  error, bounded stop/final chunk, late old chunks, and a two-second
  authorization response without an unnecessary renewal delay.
- 16 isolated recording-lease assertions.
- Portable native input helper: correlation, current channel/session/grant,
  modern curtain application/release, cancellation and renew-only routing.
- 59 portable Agent authorization assertions, including out-of-order mode
  observations and permanent revocation.
- Actual portable H.264 container output decoded by FFmpeg:
  - Baseline sample: 64×48, 2.988 seconds, 36 distinct decoded frames.
  - High-profile sample: 64×48, 2.988 seconds, 34 distinct decoded frames.
  - A recording begun at a mid-session IDR without repeated SPS/PPS also decoded.
  - Empty recordings, invalid bitstreams and changed parameter sets were tested.
  - Injected partial writes in both container writers were rejected as
    unsuccessful; a damaged file is not reported as a playable recording.
- Preview `/console` and `/api/public/health` responded HTTP 200. The new
  permission route responded HTTP 401 without device credentials.
- Public preview screenshot shows the technician sign-in screen. This is not
  evidence of the signed-in session or a Windows device test.

### Browser journey

The single coordinated browser run used a separate disposable account, license
and synthetic endpoint. Real UI sign-in, pairing inspection/redemption,
authenticated heartbeat and view-session consent succeeded. The heartbeat
contained a valid runtime instance; signaling used the fixture's matching
session, grant, controller and peer.

**Blocked before control or recording:** the browser logged a generic HTTP 503
and an ICE-gateway-unavailable warning, and the synthetic peer failed to connect.
The captured 503 log has no request URL, body or timing. The console had no video and correctly
left control/recording unavailable. No permission-refresh handshake, curtain
application, browser recording download, playback, or reconnect recovery was
verified. There is **no browser recording file or measured duration**.

If the 503 came from the ICE route, source inspection narrows it to
authorization/database validation or its four-second authorization deadline.
A TURN-provider mint failure instead
returns HTTP 200 with STUN-only configuration. The exact failing lookup/timing
was not established, so this is **not evidence of a Cloudflare outage**. Missing
remote video at the synthetic sender is not a failure criterion; it should
send video, not receive it.

Evidence: `generated-artifacts/control-recording-browser/test-blocker.md` and
the attached browser screenshots. Synthetic receipts would not prove physical
Windows behavior even if transport had connected. No real device was operated.

## Manual Windows run — source only

Use only the explicitly authorized test machine. Do not operate customer
devices as tests. Keep a person at the Windows keyboard.

The new permission endpoint was verified to be registered in the **workspace preview**.
Use that preview unless the matching live gateway release has been confirmed.
Do not test a new client against an older live gateway and treat that
client/server version mismatch as a completed acceptance test. Alternatively,
wait for a separately authorized live gateway release.

1. Extract the **entire** source archive to a fresh directory. Keep `agent`,
   `admin`, shared code and `tools` in their original layout.
2. Use Windows x64 and the .NET 8 SDK. Set `$previewOrigin` in each PowerShell
   window to the external HTTPS preview origin, **without `/console`**:

   ```powershell
   $previewOrigin = 'https://bc130126-6f69-4f4a-994e-81fba25b0be6-00-20ejwsuzuyv7v.spock.replit.dev'
   ```

   That development origin's health endpoint returned HTTP 200 anonymously
   during this handoff. It is not the production URL and may change later.
3. Stop the old test Agent locally before starting the new source. Never leave
   two Agent processes competing for the same test machine.
4. Agent, from PowerShell in the extracted root:

   ```powershell
   cd .\agent
   Unblock-File .\run.ps1
   .\run.ps1 -ApiUrl $previewOrigin -Pair
   ```

   This manually builds/runs Agent, Watch and updater source on **your** Windows
   machine. It does not create an MSI. A changed gateway origin requires fresh
   pairing; generate the pairing code in the **preview Admin**, with the needed
   view, control and recording disclosures. Do not change runtime credential
   files manually.

5. Windows Admin, on a **separate Windows technician machine**, from the
   extracted root. Do not control the same desktop that is running your Admin
   window; the curtain intentionally blocks local input on the Agent target.
   If no second Windows machine is available, native Admin acceptance remains
   pending; the browser technician can run on another computer.

   ```powershell
   cd .\admin
   .\configure.ps1
   $configPath = Join-Path $PWD 'src\admin.config.json'
   $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
   $config.baseUrl = $previewOrigin
   $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8
   cd .\src
   dotnet run
   ```

   `configure.ps1` asks for your existing **public publishable** Supabase key
   locally. Never use a service-role key or send keys/passwords in chat. Rebuild
   after configuration changes; do not use `--no-build`.

6. Do **not** run `agent/build.ps1` or an installer bundling script for this
   acceptance step; even `-SkipInno` still creates an MSI.
7. Confirm source versions in the local clients and the intended gateway
   origin. Use the preview browser Admin for the browser half of the test.

### Physical acceptance checklist

- Observe advancing H.264 video in the matching browser and native Admin,
  rather than relying on Agent encoder counters.
- Take control + curtain. Confirm the curtain appears on the **physical**
  monitor, ordinary local keyboard/mouse are paused, and the technician's video
  remains unobscured.
- Confirm remote input becomes available only after application confirmation.
  Release and confirm local input and the physical display recover.
- Test cancellation and an interrupted connection. Neither reconnection nor a
  delayed old receipt may turn the curtain or recording back on.
- Use the physical emergency gesture **Ctrl+Alt+Shift+Esc**. Windows
  **Ctrl+Alt+Del** remains available. Verify that remote access stops and input
  is released; do not regard a synthetic receipt as this observation.
- Record a sustained sample in both clients. Open the browser download and
  the native file under `Videos\ConnectLive`; verify advancing footage,
  sensible timing and the actual container. Test a native recording begun
  after the session has already been running.
- Confirm denial/revocation stops recording and no secure-desktop pixels enter
  saved footage. Never enter real passwords/PINs as a test fixture.
- Share sanitized timestamps, source versions, codec, UI outcome and recording
  playback result. Do not share credentials, SDP, device tokens or private
  desktop content.

Until those observations are supplied, physical Windows acceptance is **blocked**,
not passed.
