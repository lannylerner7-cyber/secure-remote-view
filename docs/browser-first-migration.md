# Browser-first migration: implementation and rollout

## Status

The device-shaped viewer, permission-aware action rail, disclosed pairing and
video-only protocol are implemented using the repository Windows Agent.
The Windows Admin remains available; no native distribution was retired.
This is not a claim of Windows runtime or fleet-readiness certification.

The user selected the current repository Agent as the migration baseline after
the supplied Agent archives contained no files. New foreground enrollment now
uses a single pairing window: enter code, review the named organization and
permissions, then authorize. The old Meeting ID endpoint remains for legacy
compatibility, but the updated Agent does not use it for new enrollment.

See `browser-console-agent-audit.md` for the source review of startup, updates,
watcher packaging, action dispatch and transport verification gaps. This is not
a fleet-readiness or Windows-runtime certification.

### Current continuation roadmap

1. **Source corrections implemented:** browser/native identity interoperability,
   honest legacy action states, signed staged update/recovery and deliberate
   Watch packaging. Startup remains an explicit local choice. Per-machine MSI
   updates remain IT-managed.
2. **Release activation pending:** review/apply the additive `stable-update`
   channel migration, provide the publisher public-key pin at Windows build
   time, and produce a signed runtime bundle through the protected signing
   environment. No production key, migration or release was activated here.
3. **Windows validation pending:** execute the evidence matrix in
   `browser-first-verification.md` and `agent/UPDATING.md` on designated devices.
   No first-frame, steady-state or selected Windows TURN-media results exist.
4. **Native Admin retained:** retire only after measured parity and explicit
   cutover approval.
5. **Android source blocked:** inventory the actual Android repository first.
   Pairing is backend authorization, not a substitute for Android capture
   consent, foreground-service visibility or OS input permissions. Do not
   advertise Windows-only capabilities. Request build/distribution credentials
   securely only when the real source and selected services need them.

## Viewer update

- The content rectangle follows transmitted video metadata, or the displayed
  fallback frame's dimensions. The viewport limits available space but never
  supplies the remote aspect ratio.
- Fit scales down without stretching or enlargement. 1:1 uses transmitted
  pixels per CSS pixel, with scrolling for larger sources.
- Metadata changes are observed and session-specific geometry is cleared.
  Media elements remain mounted before the first decoded frame.
- Actions are grouped into a collapsible rail. Modern control waits for the
  Agent's session/authorization-bound mode acknowledgement. Modern monitor
  selection uses a correlated receipt; the explicit legacy path queues a
  grant/session-bound monitor command and labels it unconfirmed. Reconnect replaces the
  browser peer; it does not restart the Agent or revive an ended session.
- Pause viewer is local playback only; it does not claim to pause sharing.
  End sharing changes session state. Access revocation is a separate action.
  Files and optional keyboard/trackpad controls have separate disclosures.
- TURN configuration and selected-path evidence are distinct labels.
  An open clipboard channel is not described as proof of synchronization.

Source-level native regression checks are not Windows execution tests.
Real-device video, native action execution, updater recovery and cross-network
Windows media remain rollout gates. Synthetic/API checks are not substitutes.

## Pairing and database changes

- Codes contain 60 bits of random entropy, expire after ten minutes, are stored
  only as hashes, and are single use. Issuance requires an active, owned license
  and administrative role (or super-admin); the organization is disclosed.
- Redemption locks the code and license, rechecks issuer/owner/license state,
  enforces the seat limit and atomically records the device and authorization.
  A retry with the same attempt and token hash returns the same enrollment;
  a different attempt cannot consume it again or replace its token.
- Revoking an unused code is distinct from revoking a paired device's access.
  Revoked grants cannot be revived through the retry path. Local stop/revoke
  and the existing unattended/attended distinction remain effective.
- The Agent creates its device token locally, sends its hash and persists the
  returned grant/credential with the existing protected local store.
- Rate limits are database-backed and fail closed. Corporate bulk enrollment
  and 10,000-device capacity have not been load-tested.
- Additive migrations `20261103000000_disclosed_device_pairing.sql` and
  `20261103001000_browser_video_sessions.sql` were applied to the confirmed
  Supabase project after rollback-only behavioral checks. Existing rows default
  to legacy media mode; no existing device was re-enrolled.
- Workspace-only upgrade runner:
  `node scripts/apply-browser-first-migrations.cjs --check` (rollback),
  then `--apply` (explicit commit). It verifies TLS, target and migration history.
  Do not replay the raw historical migration chain. The fresh installer retains
  its original 64-file checksum-verified baseline; later upgrades are separate.

## Video-only contract

- Agent 1.10.0 advertises `browserVideo: 1`. New browser sessions for capable
  Windows Agents use immutable `media_mode: video`. Older devices/sessions keep
  the explicitly labeled legacy transport; do not mistake compatibility for
  video-only coverage of the entire installed fleet.
- Video-only capture does not create the JPEG encoder/upload worker. It feeds
  DXGI (or GDI capture recovery) to WebRTC. GDI capture recovery still produces
  video, not HTTP image frames.
- The browser never subscribes/polls for JPEG in these sessions. Both the frame
  API and database reject JPEG writes for video-only sessions.
- Software VP8 is the negotiated baseline for this protocol. Legacy H.264 paths
  remain untouched; hardware codec parity needs measured Windows validation.
- Video-only input has no database/HTTP queue. The native poller is disabled;
  discrete browser input is not sent twice. Congestion/disconnection rejects
  input rather than replaying stale keystrokes later.
- Mode changes update the existing permission gate without tearing down the
  media peer. Input channels are bound to the session; monitor requests time out
  as unknown rather than manufacturing an applied state.
- Closing a viewer tears down only its peer-local permissions/channels; session
  authorization and signaling remain available for reopening. Video-only
  offer/answer/ICE/bye messages carry a viewer-instance ID, so a late old bye or
  answer cannot affect the replacement. Full session end still revokes the
  parent permission. Loop health also detects a fully closed RTC session.
- Capture, heartbeat presence, authorization, install history and the selected
  ICE path are separate states. Ending a live session does not uninstall or
  silently disable an otherwise authorized presence agent.

## Configuration and rollout

No D1 migration, new worker or secret was introduced. Keep existing server-only
Supabase and TURN credentials on the server; never put them in `VITE_*`, client
ZIPs or Git. A publishable key is not a service-role key. ICE configuration is
not evidence of a selected relay path.

Deploy the compatible server and updated Agent together when Windows validation
passes. The current workspace applies the additive schema; app startup does not
run migration scripts. Preserve the native Admin during this staged rollout.
Source archives are not executable update packages.

## Preserved contracts

- Legacy Meeting IDs are not relabeled as pairing codes.
- Device authorization is separately recorded and matched locally against the
  server grant. Device enrollment alone does not authorize capture.
- The Agent checks heartbeat authorization before dispatching session invites.
  Unattended invitations can be accepted under the recorded grant; attended
  invitations require acceptance.
- JPEG compatibility remains only for legacy-mode sessions. Hardware capability
  and actual encoder output are separate facts.
- Browser controls and native controls are not automatically equivalent.

## Capability inventory

| Capability | Current source path | Migration requirement |
| --- | --- | --- |
| Enrollment | Disclosed pairing for updated Agent; legacy endpoint retained | Browser/API verification plus actual Windows installation check |
| Screen video | Agent WebRTC plus browser receiver | Verify first-frame delivery, direct and TURN paths |
| JPEG fallback | Disabled on both ends for video-only mode | Keep legacy compatibility clearly separate |
| Keyboard/mouse | Ordered live channel, mode acknowledgement and Agent scope enforcement | Validate Windows execution and reserved shortcuts |
| Display selection | Direct command with correlated applied/rejected/timeout receipt | Receipt confirms selection, not presentation of the next video frame |
| Files | Data channel and HTTP archive UI | Verify bounds, permission rejection and interruption behavior |
| Clipboard | Scoped channel plus browser clipboard API | Explain browser permissions; report blocked operations |
| Recording | Browser MediaRecorder with renewable authorization | Verify MIME support, revocation and saved output |
| Privacy curtain | Unavailable in browser protocol; legacy control scope disclosed | No implicit curtain on control; Windows recovery remains unverified |
| Windows Hello | Not a general remote bypass capability | Respect OS authentication; browser passkeys are a separate feature |
| Power operations | Explicit platform/authorization restrictions | Do not inherit power authority from view/control |
| Presence | Agent heartbeat independent of live media | Keep presence distinct from capture, installation and authorization |

## Required verification before cutover

Completed checks and remaining hardware gates are recorded in
`browser-first-verification.md`. The list below remains the cutover checklist,
not a claim that compilation proves Windows behavior.

1. Use the repository Agent baseline selected by the user; preserve any later
   supplied source changes only after an explicit comparison.
2. Test pairing expiry, replay, concurrent redemption, tenant isolation and
   revocation with a real database transaction.
3. Verify session acceptance and media progress independently. ICE connected
   is not proof that a frame has been decoded.
4. Confirm no JPEG encoding/upload/subscription occurs in migrated sessions.
5. Exercise direct and TURN Windows-to-browser sessions, reconnect, monitor
   changes, competing technicians and permission withdrawal.
6. Measure first-frame and steady-state latency on Windows. Linux compilation
   and source checks cannot supply those results.
7. Keep native Admin source and distribution until browser parity is
   demonstrated; do not push, publish or retire clients automatically.
