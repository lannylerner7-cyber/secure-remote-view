# Browser-first verification — 2026-11-03

## Previous browser-first baseline evidence

- Web TypeScript check and production build.
- Agent 1.10.0 Windows-targeted cross-build: zero errors; three existing
  async/DPI warnings. Native gateway harness: 22 checks passed.
- Managed lifecycle harness: 15 checks against the production peer-binding and
  permission classes cover viewer close/reopen, a late old-viewer bye both
  before and after a replacement offer, peer-local cancellation, parent mode
  changes and permanent session revocation. These are not Windows transport
  or capture tests.
- Geometry cases cover portrait, landscape, ultrawide, mobile constraints,
  fractional scaling, unknown metadata and 1:1 scrolling. Extracted actual
  frame components were inspected at desktop and mobile sizes.
- Protocol tests cover permission/session binding, monitor receipts,
  rejection/timeout/disconnect, congestion rejection, video states, no duplicate
  input dispatch, no JPEG subscription for video-only mode and stale-peer guards.
  Viewer-instance tagging/filtering is exercised for queued signals and final
  bye, with source guards ensuring peer teardown cannot revoke the session or
  cancel its signaling pump.
- Reconnect route rejects wrong devices, missing consent, ended and revoked
  sessions while preserving the existing authorized path.
- 21 rollback-only checks against the actual Supabase schema cover pairing
  ownership/roles, disclosure, expiry, replay, token replacement, same-attempt
  retries, seats, revocation, gateway identity, rate limits, private RPC/table
  permissions and immutable video/JPEG rejection.
- The reviewed 64-migration fresh-install checksum and sanitization/TLS/atomic
  history self-tests pass. The two additive browser-first migrations were
  explicitly applied; no old migration chain was replayed.

## Signed-in preview check

One isolated account/license and a synthetic, non-capturing device were used.
The real Windows Agent was not run.

- Normal sign-in, organization/license selection, unattended disclosure,
  view-only defaults, selecting control, countdown and copy feedback worked.
- Concurrent redemption produced exactly one HTTP 200 and one HTTP 409.
- The winning device authenticated its heartbeat; the grant matched the
  selected view/control permissions.
- Browser-created video session and synthetic-device consent succeeded.
  The waiting/no-decoded-video state explicitly said there was no JPEG fallback.
  No JPEG request path appeared in the monitored interval. Control stayed
  disabled without an Agent mode acknowledgement.
- Desktop action rail measured 192px at a 1280px viewport. Mobile rail measured
  357px in a 390px viewport; document width remained 390px. A subsequent
  deterministic style correction gives disabled outline actions readable labels
  on the dark viewer; it does not alter authorization or action behavior.
- The active HTTP reconnect route succeeded. After End sharing it returned
  HTTP 409 and the session remained ended. This route check did not exercise
  an actual Agent peer reconnect.
- UI access revocation succeeded; subsequent consent returned HTTP 403,
  authorization reported `allowed: false`, and input polling returned no items.
- Revoking a second unused code made inspection return HTTP 400.
- The Agent ICE endpoint returned HTTP 200 with TURN available. A forced-relay
  browser candidate was gathered. Gathering did not reach complete, and no
  provider-specific HTTP response was captured. This verifies relay allocation,
  **not selected Windows relay media, rendering or latency**.
- Synthetic heartbeat stopped, sign-out completed, and guarded cleanup removed
  the fixture account/license/device and private credential file.

## Remaining release gates

- Actual Windows DXGI/GDI-to-VP8 frames, first-frame and steady-state latency,
  multi-monitor pointer mapping, direct/relay media, network loss and reconnect.
- Native execution/receipts for control, clipboard, files and recording;
  browser/OS permissions and reserved key behavior.
- Windows startup, local withdrawal, actual Watch installation, signed update
  handoff and rollback. Source corrections are described below; compilation and
  managed tests do not close these Windows gates.
- Hardware H.264 parity and any eventual native Admin retirement.
- Fleet/load testing. No claim of 10,000-device capacity or instant actions.

Preview root returned HTTP 200; `/health` returned `OK`. Public-page screenshot
showed the app rendered normally. Startup logs included cancelled-request
`ECONNRESET`/SSR errors and existing framework deprecation warnings, so this is
not a claim of a warning-free log.

No GitHub push, production publish, Windows installation, ZIP generation,
new Cloudflare worker or secret change was performed in this task.

## Reconnect lifecycle correction

The final review found that a browser bye closed the whole Agent RTC session,
including its signaling pump and shared permission. It now closes only the
peer and cancels peer-local input/file/clipboard callbacks. The authorized
session can accept another offer, while full session end still revokes the
parent permission. Loop health also recognizes a fully closed RTC instance.

Browser offer/answer/ICE/bye messages are correlated by a per-viewer UUID;
replacement viewers use distinct realtime subscriptions. Late old-viewer bye,
answer and ICE messages cannot affect the replacement. Existing untagged
native Admin signaling remains compatible, but does not gain the browser's
viewer-instance fencing. Real Windows close/reopen and network-failure checks
remain release gates.

## Continuation: source corrections and measured-check boundary

The browser identity generator now feeds a fixture into the production native
signal parser/binder. Browser-prefixed identifiers no longer fail UUID-only
validation. Legacy control and monitor paths explicitly distinguish authorization
from an acknowledgement; no applied receipt is fabricated.

Current repository checks passed:

- Web TypeScript and production build.
- Agent, Watch and Update cross-builds: zero errors. Agent retains its three
  existing async/DPI warnings; Watch/Update have none.
- 22 gateway, 15 peer-lifecycle and 46 signed-package/transaction assertions,
  plus the actual browser-identity fixture. Update tests use real signatures
  and filesystem copies with a **model process/health adapter**.
- Existing native streaming and Agent UI source-regression checks.
- MSI XML parsing only; this is **not** WiX compilation or installation.
- Publisher public-key embedding, rejection of private-key embedding, and the
  real packager CLI passed with an ephemeral test key and non-executable dummy
  runtime files. This did not produce a Windows release.
- Installer component/custom-action references resolve, and source-archive
  inventory includes the new dependencies without binaries/key files.
- After one managed web restart, `/health` returned `OK`, unauthenticated
  release/beacon requests returned HTTP 401, and the public homepage screenshot
  rendered normally. This does not verify a signed-in Windows live session.
  Startup logs still contain existing framework deprecations and an aborted
  request reported as `ECONNRESET`/SSR 500; they are not warning/error-free.

Updater source now includes publisher verification, an idle/old-process-exit
handoff, durable recovery journal, candidate health and explicit Watch packaging.
See `imports/connectlive/agent/UPDATING.md`. No production signing key, release
row, bundle publication or database migration was configured/applied.

### Actual Windows evidence — NOT RUN

No designated Windows device/runner was supplied. All rows below remain open;
there are no measured latency values or selected Windows media paths to report.

| Windows scenario | Required evidence |
| --- | --- |
| DXGI and GDI → VP8 | Actual capture backend; negotiated VP8; first decoded-frame event; increasing `framesDecoded`, dimensions and frames presented. |
| Direct and forced TURN | Selected transport/candidate-pair ID and local/remote candidate **types**, relay protocol and decoded frames. ICE configuration/allocation alone does not count. |
| First-frame latency | Start timestamp at viewer connection request; first `requestVideoFrameCallback` with a presented frame. Repeat and report sample count, median and p95. |
| Steady-state latency | Source timecode/counter observed on both displays with a stated clock/camera method. Report distribution and dropped/frozen intervals; RTT alone is not display latency. |
| Network loss / reconnect | Loss/recovery times, new peer identity, fresh frames and input after recovery; End sharing/revocation must not reconnect. |
| Portrait / multiple monitors | Source dimensions, rotation/DPI and selected monitor; corner/center pointer and drag/keyboard mapping in fit and 1:1. |
| Competing technicians | Binding/conflict outcomes; late messages cannot control the replacement viewer. |
| Control / clipboard / files / recording | Requested vs acknowledged vs applied evidence; verify receiver contents/file hashes and playback of an actual recording. |
| Local / server revocation | No further frames/control, no revival by reconnect/Watch/update; authorized presence is distinct from sharing. |
| Installation / recovery | Run every applicable Windows row in `agent/UPDATING.md`, including worker interruption and local withdrawal. |

Use disposable, explicitly authorized test devices. Record OS/build, Agent
version, browser, capture backend, monitor geometry and network scenario.
Include source revision/build hashes as well as the displayed version, so stale
assemblies cannot be mistaken for the tested source. Store only allowlisted
diagnostic fields: omit tokens, ICE credentials,
cookies, full SDP, configuration/credential files and private keys. Do not
export an entire raw stats report or a full browser network archive.

Native Admin is retained. Cutover requires measured parity **and explicit
approval**, not a successful Linux build.

### Android source inventory

The checkout has no Android application build. Nine supplied ZIP names were
inspected by central directory: five contain Windows/web material without
Android source indicators, three are empty, and one is a zero-byte invalid ZIP.
No Android Gradle files, manifest, Kotlin or Java source were found. This does
not establish that the user's external Android MVP does not exist.

No Android implementation, signing request or Google configuration was invented.
The actual repository/source is still needed before platform/media capability
negotiation, Android capture consent/foreground service and input lifecycle work.
