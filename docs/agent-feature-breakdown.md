# ConnectLive remote-access Agent — feature gaps and breakdown

Reviewed 2026-11-05 against the current repository Windows Agent and its browser
console. This concerns the remote-access application, **not the talking homepage
guide or payment admin**.

This is a source inventory and proposed work breakdown. No Windows device was
connected, no native binaries were built, and no Agent functionality was changed
for this review. “Implemented” below means implementation exists, not that every
device/OS/network combination has passed acceptance testing.

## 1. Already implemented — do not list these as missing

| Feature | Existing implementation | Remaining acceptance work |
| --- | --- | --- |
| Pairing and enrollment | Pairing-code UI, organization/access context, local acceptance and device credentials. | Fresh profile, expired/used code, retry, incorrect organization and re-pairing on Windows. |
| Device identity protection | Per-user DPAPI-protected credentials and authenticated API calls. | Profile changes, revoked credentials, reinstall and safe recovery. |
| Attended/unattended access | Recorded grants, selected capabilities and attended-session decisions. | Verify scope enforcement and withdrawal across every live channel; unattended must not mean unapproved. |
| Presence and lifecycle | Heartbeat, Agent/Watch lifecycle source, process status and console state. | Distinguish Agent stopped, Watch unavailable, offline and explicitly uninstalled using real device evidence. |
| Desktop capture | DXGI capture with GDI recovery paths. | Locked screens, GPU reset, display changes and driver compatibility. |
| Live video | WebRTC, VP8/H.264 negotiation, encoder code and adaptive quality. | Fresh decoded frames, first-frame delay, codec compatibility and actual hardware acceleration. |
| Frame fallback | JPEG/HTTPS paths exist where the session mode permits them. | Verify recovery and latency. Video-only mode must not silently use JPEG. |
| Mouse, keyboard and cursor | Input relay, cursor updates and peer-bound permission guards. | DPI, keyboard layouts, correct display targeting and immediate permission withdrawal. |
| Monitor switching | Monitor inventory, selected-monitor state, browser picker and acknowledged switch actions. | Rotated/negative-origin displays, hot-unplug and switching during active capture. |
| Text clipboard | Explicit text-only, capped clipboard channel with permission checks. | Both directions, Unicode, limits and withdrawal. Images/files are a separate gap below. |
| File transfer | Session-file UI, native transfer, checksums and data-channel/HTTP paths. | Actual end-to-end transfers, failures, quotas, integrity and permission revocation. |
| Privacy curtain | Native overlay/controller, browser acknowledgements and failure handling. | What the local user actually sees, what the technician sees, multi-monitor coverage and cleanup after failure. |
| Recording support | Recording capability checks and viewer-side recording support. | Recording is a cross-client feature, not proof of a standalone Agent recorder. Verify start/stop, playback, storage and withdrawal. |
| Power/device actions | Existing command relay and technician controls. | Verify each allowed action, separate authorization, OS rights and recovery. Screen-control permission alone is not sufficient authority. |
| Reconnect and relaunch | Peer recovery, Watch/relaunch and lifecycle receipt source. | Crash, sleep/resume, lost network, old-peer signals and successful process readiness—not just a launch request. |
| Updates and rollback | Update verification, helper, transaction journal and recovery source. | Interrupted/corrupt update, rollback, version reporting and protected installation locations on Windows. |
| Withdrawal and uninstall | Local disable path, durable withdrawal state and uninstall/lifecycle handling. | Confirm every process/channel respects withdrawal and that absence is not falsely reported as uninstall. |
| Packaging and signing | Source build scripts and installer/signing/deployment templates. | User-run Windows source testing first; signed installer and upgrade/uninstall proof afterward. Do not auto-build release packages here. |

## 2. Missing or not currently supported — separate work items

These are bounded findings from the reviewed source, not a claim that every
possible remote-support feature must be added. Priorities below are
recommendations, not approved implementation tasks.

| ID / priority | Feature and current gap | Work breakdown | Acceptance criteria |
| --- | --- | --- | --- |
| A1 / P1 | **Resume interrupted file transfers.** The native data channel drops its partial in-memory receive state on close/error. HTTP fallback is not proof of durable byte-offset resume. | Persist bounded transfer IDs/checkpoints; resume only after reauthorization; verify offsets and final digest; expire abandoned data. | Disconnect mid-file, reconnect and finish without corruption or restarting completed bytes. Revoked/expired transfers cannot resume. |
| A2 / P1 | **Rich clipboard.** Current clipboard is text-only; screenshots/images and copied files are not the same supported capability. | Add explicit format allow-lists, payload limits and direction controls. File paste must also respect file-transfer permissions and safe paths. | Text keeps working; approved image/file formats transfer correctly; unsupported/oversized content and revoked access are rejected. |
| A3 / P2 | **Remote file explorer/folder operations.** The current panel lists session files; a complete remote filesystem browser was not found in the reviewed flow. | Define permitted roots; add directory listing and selected transfers. Treat rename/delete/folder creation as separately authorized, audited operations. | Cannot escape allowed roots through paths or links; denied operations fail clearly; destructive changes require the agreed authorization. |
| A4 / P2 | **Remote computer audio and optional microphone.** The reviewed native peer publishes a video track, not a complete audio capture/playback path. Homepage guide speech is unrelated. | Add system-audio capture and an audio track; separately authorize microphone capture; expose mute/device selection; handle synchronization and device loss. | Technician receives authorized computer sound; microphone stays off unless explicitly permitted; mute/revoke/disconnect stops capture. |
| A5 / P2, UI decision | **Two-way in-session text chat.** No complete end-user/technician chat flow was found; the existing Telegram/admin notifications are not this feature. | Agree how messages appear on the remote device; bind messages to the session; add delivery states, limits and retention. | Only session participants exchange messages; ended/revoked sessions cannot continue. This must not silently reintroduce the status/chat windows excluded by the agreed Agent UI. |
| A6 / P2 | **Managed multi-technician co-support and handoff.** Current Agent coordination maintains one active WebRTC session object; full shared viewing/control ownership was not established. Multiple licensed operators do not prove concurrent control of one endpoint. | Design participant authorization, view-only joins, one control owner, explicit handoff and audit. Recheck entitlements and grants for every participant. | Two technicians can join under the agreed policy without fighting for input; handoff and departure do not expose or terminate an unrelated authorized session. |
| A7 / P2 | **Simultaneous all-monitor overview.** Switching between monitors exists; the current capture selector chooses one target. | Add a composed overview or multiple tracks; preserve per-display geometry and clear control targeting; bound bandwidth. | All selected displays remain readable and input lands on the intended monitor across DPI, rotation and hot-plug changes. |
| A8 / P3, optional | **Remote printing.** No complete printer/job forwarding path was found in the reviewed Agent/console source. | Define supported job formats, explicit destination selection, job transport, cancellation and cleanup. Do not silently install privileged drivers. | A permitted job reaches only the selected printer; failures/cancel are visible; temporary documents are removed according to policy. |
| A9 / separate approval | **UAC/secure-desktop and pre-login operation.** Secure-desktop access is explicitly not enabled; the current per-user Agent is not proof of pre-login service support. | First decide whether the product should support this. Any privileged component needs explicit installation authority, narrow permissions, a threat review and Windows acceptance tests. | Never bypass Windows consent or infer elevated authority from ordinary screen-control grants. Existing user-level operation remains safe if this feature is not approved. |

### Evidence behind the gap classifications

- `imports/connectlive/agent/src/WebRtcSession.cs` publishes the video track and
  routes `files`, `clip` and `input` channels; other channel labels are closed.
- `imports/connectlive/agent/src/Agent.cs` coordinates one `_rtc` instance and
  closes/replaces it during session transitions.
- `imports/connectlive/agent/src/MonitorSelector.cs` resolves one selected capture
  target. `WebRtcSession.Actions.cs` and the browser `MonitorPicker.tsx` already
  implement monitor switching.
- `imports/connectlive/agent/src/FileTransfer.cs` clears partial incoming state
  on channel close/error. The session file panel is not a machine-wide explorer.
- `imports/connectlive/src/routes/_authenticated/console.tsx` explicitly states
  that Windows secure-desktop access is not enabled.
- Absence findings for chat/printing/audio are limited to the inspected
  repository paths. A separate implementation must be supplied and compared
  before adopting it or claiming it is complete.

## 3. Release-critical verification — not missing features

These should precede optional feature expansion:

1. **Real Windows first connection:** pairing → authorization → first fresh
   decoded frame → permitted input. Measure first-frame delay and frame
   progression; moving cursor or a successful ICE connection is insufficient.
2. **Recovery:** viewer reopen, network change, TURN-only network, sleep/resume,
   Agent crash/relaunch and stale old-peer messages.
3. **Permissions:** view-only isolation; clipboard/files/recording scope;
   withdrawal while operations are in flight; independently authorized power
   actions.
4. **Curtain and displays:** verify local versus remote output, all affected
   monitors, input-lock release and failure cleanup on actual Windows hardware.
5. **Updates and installation:** user-run source build, preserved settings,
   verified update, interruption/rollback, protected paths and truthful lifecycle
   reporting. Installer bundling follows—not precedes—manual source testing.
6. **Browser/native parity:** keep the native Admin available until measured
   parity and explicit approval to retire it.

Existing acceptance references:
[Windows checklist](agent-windows-verification.md),
[lifecycle implementation](agent-lifecycle-implementation.md), and
[browser-first evidence](browser-first-verification.md).
Older review documents contain pre-implementation findings; unchecked historical
roadmap boxes must not automatically be counted as current missing code.

## 4. Platform and UI boundaries

- **Windows:** this repository is the chosen Agent baseline.
- **Android:** the user reports an external implementation in progress. Its source
  and build are needed for a fair feature-by-feature review; do not label it
  absent or unstarted because it is outside this checkout.
- **macOS/Linux:** a working native Agent for either is not established by this
  Windows source inventory. Packaging labels alone are not a client.
- **Minimal local UI:** one pairing-code screen with inline access context.
  No status window, tray menu or Stop/Disconnect control UI is intentional,
  not a missing-feature bug. Local disable and uninstall must remain functional.
- **Remote terminal/arbitrary scripts:** not a routine missing feature. The
  repository deliberately accepts a closed set of input/command operations;
  do not add unrestricted command execution as part of this breakdown.

## Recommended sequence

1. Complete the Windows acceptance gates above.
2. Add A1 transfer resume and A2 richer clipboard if product demand justifies them.
3. Select A3–A7 according to customer needs; agree chat UI and collaboration
   permissions before implementation.
4. Treat A8 printing as optional and A9 elevated/pre-login support as a separate
   product/security decision.

No implementation, deployment, native build or remote endpoint action is
authorized merely by appearing in this roadmap.
