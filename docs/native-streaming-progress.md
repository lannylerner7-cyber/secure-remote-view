# Native streaming investigation — 2026-10-22

## Status: partial implementation, NOT a production certification

The source-level bottleneck confirmed here is a serial await of the HTTP JPEG
fallback upload inside the DXGI/WebRTC capture loop. This means a slow fallback
upload also delays the next WebRTC frame. It is a plausible contributor to the
reported 5–6 seconds, NOT proof that it explains all observed latency.

### Implemented

- One upload worker with capacity for a single replaceable pending JPEG; capture
  never waits for HTTP. Upload cancellation follows both session and permission
  cancellation; each upload has a three-second deadline. Existing upload
  authorization and adaptive-quality feedback remain in place.
- DXGI falls back to GDI on the requested monitor rather than capturing an
  unrelated default display. ReleaseFrame only follows successful acquisition
  and targets that acquisition's duplication object.
- Native Admin Start/Stop are idempotent. Concurrent reconnect requests are
  collapsed, and reconnect HTTP calls use session cancellation instead of
  CancellationToken.None. Taken-over/stopped sessions cannot request reconnect.
- Native data-channel input now uses the same nested kind/payload envelope as
  REST and the Agent parser. Late callbacks from old channels cannot change a
  replacement channel's state; cancelled input is rejected before sending.
- MSI version uses the project version with valid three-field MSI limits and is
  passed into the assembly build. Only requested installers from this run are
  signed/archived; previous generated installer outputs are removed explicitly.
- GPO detection reads the MSI's actual ProductCode without Win32_Product repair
  enumeration. The MSI build generates Intune metadata from that ProductCode.
- A narrow database migration allows control under an already-recorded control
  grant, preserving identity/state/ownership/revocation checks. It was applied
  transactionally to the configured Supabase project, with an unknown-session
  denial check; no application rows were modified. Reconnect only updates active
  rows and requests ICE recovery instead of attempting paused-session activation
  or sending an unrelated wake command.
- Reproducible source-only archive builder includes shared Admin dependencies,
  signing helper and documentation, verifies every archived file checksum and
  refuses to overwrite an existing archive. Output is a review snapshot, not
  a verified production release.

### Checks

- LatestWorkPump executable .NET test: blocked upload does not block producer;
  frames 2–99 are replaced with frame 100; cancellation stops in-flight work and
  rejects subsequent submissions.
- Native-input executable tests: nested payload, old-peer callback isolation,
  cancellation, session routing, safety fallback and acknowledgement freshness.
- Disposable local PostgreSQL tests now load all five actual production session
  triggers and five session RLS policies, plus the actual authorization
  predicates. Authenticated updates verify recorded-control success and reject
  view-only/revoked grants, wrong technicians, identity edits and paused/ended
  reactivation. Both transition guards are reconciled by the corrective migration;
  the earlier reduced fixture missed the second guard and is superseded.
  This verifies the database path, not a live native/PostgREST or Windows journey.
- Commit-labelled archives compare every archived source byte to git show for
  the published commit. A remote SHA match alone is no longer sufficient.
- Static regression checks cover integration, DXGI frame ownership, MSI version
  and staging, and native Admin lifecycle guards.
- Clean Linux Windows-targeted compilation is recorded separately from runtime
  verification. Neither DXGI nor MSI installation can run on this Linux host.
- Both fresh-source Agent and Admin builds completed with zero errors (Agent:
  three warnings; Admin: existing nullable/DPI warnings). Parallel build attempts
  produced restore-only logs, so only the subsequent serial builds with explicit
  completed build reports count as verification.

## Remaining blockers

1. Native data-channel curtain commands now receive correlated applied/failed
   acknowledgement after the UI-dispatcher overlay action. Admin rejects old-peer
   replies and replies older than three seconds (using its echoed monotonic send
   timestamp), expires confirmation after five seconds, and never treats a sent
   request as applied. REST fallback has no receipt and remains unconfirmed.
   Capture-exclusion failure cleans up partial overlays and releases input.
   Display hot-plug/per-monitor DPI and physical local recovery need Windows tests.
   Do not describe the button as end-to-end verified.
2. Full session API/database contract reconciliation, takeover/multi-window
   ownership and token expiry behavior remain incomplete. The identified
   control-PATCH conflict is corrected by the recorded-grant migration, and
   reconnect no longer attempts to reactivate paused/closed sessions. Full
   native/backend runtime lifecycle verification remains blocked on Windows.
3. JPEG encoding is still performed by the capture loop; the upload split does
   not eliminate CPU encoding cost. Measure software VP8/H264, UI/decode queues,
   RTT, selected ICE pair and server response times before further tuning.
4. MSI compiler and install/upgrade/uninstall have not run. GPO/Intune detection
   previously used UpgradeCode as ProductCode; source handling is corrected but
   needs Windows verification. Existing installer startup behavior also remains
   under review; these sources must not be advertised as production-ready.
5. No genuine before/after p50/p95 screen-to-screen timing is available. Collect
   synchronized two-device screen-clock recordings plus Agent/Admin diagnostics
   for LAN, direct WAN, TURN, reconnect and display-change cases. Report first
   frame and steady-state delay separately; do not confuse decoder-only latency
   with capture-to-display latency.
6. The prior SSH private key is unavailable here. The secure GitHub proxy is
   available; final push outcome is recorded in the delivery message and archive
   manifest, not inferred from a successful local build.

## Coverage boundaries

Semantically reviewed in this pass: capture upload control flow, DXGI acquire/
release and display selection, Admin Start/Stop/reconnect and curtain dispatch,
Agent curtain dispatch and native acknowledgement path, Agent build
version/archive stages and MSI wrapper.
Inspected only: WiX identity, GPO detection, signing helper location, existing
WebRTC recovery timers and input transport. The remainder of both clients and
backend is not newly certified. See the file inventory for explicit statuses.
