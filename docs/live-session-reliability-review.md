# Live Admin reliability review

Review date: 7 November 2026 (America/Los_Angeles).

## Decision

**Keep Supabase, Coolify and Cloudflare TURN for this repair. Do not migrate to
D1 to solve a video, ICE or encoder problem.** No infrastructure, checkout,
pricing, GitHub or production deployment change was made.

The preview contains a reliability candidate and additional diagnostics. The
Windows Agent source candidate is **1.10.9**. Neither an Agent executable nor an
MSI was built. Production and Windows acceptance are not implied by a successful
preview or portable test.

## What the supplied Windows log actually establishes

The reviewed terminal log was supplied on 7 November and identifies Agent
**1.10.8**, gateway **https://connectliveagent.com**, and legacy media mode.

- The VP8 native dependency load failed for `VCRUNTIME140.dll`, with Windows
  error 126. The accompanying `vpxmd.dll` was present and had the expected
  architecture. This does not distinguish a missing dependency from a damaged,
  blocked or otherwise unloadable runtime. Follow the approved manual repair
  procedure in `agent/VIDEO-DEPENDENCIES.md`; do not install dependencies
  automatically.
- H.264 QSV hardware discovery was logged, but discovery is not encoder output.
  Two H.264 answers were posted. The reported pipeline still had
  `pushed=0 encoded=0 started=False`; the excerpt did not establish a connected
  peer, an open command channel or advancing encoded frames.
- Five later offers were rejected as `VideoIncompatible`. A network failure
  must not by itself force an otherwise usable H.264 path onto VP8 when the VP8
  runtime is unavailable.
- **`peer=none` means no existing peer-connection object. It is not evidence
  that the offer omitted its peer identity.**
- Successful heartbeats took approximately **2.7–19.2 seconds**, with reported
  server time approximately **2.4–18.3 seconds**. Five heartbeat timeouts occurred
  around 20 seconds. One 503 reported `runtime_reporting_unavailable` at
  `runtime_write`, with roughly 18 seconds elapsed and 16.9 seconds server time.
  The last stage name does not establish that it consumed all that time.
- JPEG requests repeatedly exceeded their three-second client deadline; the
  reported failure streak reached 60. Seven successful uploads were logged.
  A JPEG proves capture and that HTTP path, not a healthy WebRTC encoder.
- Local transport teardown after HTTP errors was followed by resuming the same
  support session. Those lines were not confirmed administrator-end receipts.
- Ten configured ICE URLs and `turn=True` prove configuration only. They do not
  identify a selected relay, traffic delivery, decoding or presentation.

The public production homepage returned HTTP 200 in approximately 1.72 seconds
during this investigation. That is **not** a heartbeat measurement. The exact
externally deployed backend commit and Coolify host/process resource metrics
were not established.

## Implemented changes

### Signaling and media recovery

1. Realtime notifications and a bounded, authenticated catch-up read now share
   one peer-scoped inbox. Missing/reordered answers can be recovered without
   confusing a later candidate's row ID with proof that all earlier rows arrived.
   Overlapping delivery is deduplicated; failed applications remain retryable.
2. Early local ICE is held behind the offer. The ICE watchdog no longer starts
   merely because an offer was queued behind a slow signaling request. The
   existing overall startup deadline remains bounded.
3. Network/signaling failures change the network route without automatically
   changing codec. Media/unsupported-codec failures remain separately classified.
   Restored TURN during startup requests a fresh peer generation rather than
   replacing an outstanding offer under the same peer identity.
4. The Agent tears down an incompatible peer before waiting for its scoped
   unsupported-codec result to reach the gateway. Local cleanup does not wait
   for a slow failure receipt. This is not a replacement for a working codec.
5. Agent signaling distinguishes temporary lookup/authorization failure from
   missing or denied access. Startup catch-up anchors on the current
   controller's offer, not a later offer from a superseded controller.

### Request load and observability

1. Console refreshes are coalesced to one in-flight refresh and one trailing
   refresh. Requests are bounded and aborted on disposal. A snapshot started
   before a local mode write cannot overwrite that mode with older state.
2. Optional Windows-unlock status checks are sequential, only run with the
   required permission, back off on failure, and stop automatic polling after
   explicit denial. A manual status refresh remains available. No PIN/unlock
   action is automatically retried.
3. A heartbeat reuses an active session it already read and independently
   authorized during that same request. It does not cache authorization across
   requests. Missing, ended and mismatched sessions retain their exact scoped
   lookup.
4. Gateway diagnostics report per-stage durations, the slowest stage and the
   diagnostic protocol. Parallel stage durations no longer share a mutable
   start time. Cancellation stops subsequent stages when the request's abort
   signal is propagated; it cannot undo an already dispatched database write.
5. **Connection diagnostics** separates configured TURN, selected candidate
   types, relay use, connection/channel states, RTT/loss/jitter, bytes,
   decoded/presented frames and frame age. Copy exports allowlisted metadata,
   not credentials, SDP, candidate addresses, screen contents or PINs.
6. Pointer capture reports an explicit unsupported/denied-browser error rather
   than silently doing nothing. Clipboard messaging continues to distinguish
   queued delivery from confirmed remote application.
7. The browser check exposed a pointer-release trap and a video surface that
   intercepted the Type button. Explicit Esc/F8 interception now runs before
   remote-key handling; release clears queued movement and requests held-input
   cleanup. The
   bounded desktop layout keeps video within its allocated space, while narrow
   layouts retain a scrollable, non-overlapping stack.
8. Periodic session refreshes no longer refocus the remote surface over an
   operator's typing or PIN field. Unlock status refresh has a readable control
   against the dark viewer background.

Protocol **2** identifies the new diagnostic/signaling contract, not a source
commit or proof of a production rollout.

## Before/after evidence and its limits

| Case | Before | Candidate evidence |
| --- | --- | --- |
| Missing realtime answer | No durable browser catch-up | Actual wrapper test recovers through a scoped snapshot; duplicate and late results are rejected |
| Slow offer delivery | Could consume ICE watchdog before negotiation reached the Agent | A 21-second delayed-offer test stays connecting; the ICE budget starts after the answer |
| Network failure with H.264 | Automatic profile rotation could force VP8 | Tests preserve H.264 while alternating routes; explicit unsupported-codec failure can change codec |
| Refresh burst | Each request could start six more reads | 50 requests during an in-flight read produce one current and one trailing refresh, with peak concurrency one |
| Optional status outage | Fixed five-second polling could overlap | Sequential checks back off from 15 seconds to two minutes; explicit denial stops automatic checks |
| Active heartbeat | Additional observed-session lookup | Test confirms one round trip removed while fresh session authorization still runs |
| Parallel timing | Shared start time could misattribute duration | Controlled overlap records 22 ms and 7 ms independently and identifies the 22 ms stage |
| Cancelled request | Could continue into later database stages | Test permits the dispatched write to finish but proves no subsequent stage starts |

These are controlled regression results, **not measured production speedups**.
There is no claimed production p95 improvement, native encoder fix, or
20-minute Windows stability result.

## Verification

- TypeScript checking: passed.
- Production build: passed; existing dependency directive/deprecation warnings
  remain.
- Targeted JavaScript regression suite: 104 tests, including the added active
  heartbeat case, passed across the recorded runs.
- Browser ICE wrapper: 22 mocked-browser/transport scenarios passed.
- Browser recording helper: 19 mocked-browser/transport assertions passed.
- Portable .NET: 55 HTTP-diagnostic, 54 authorization and 31 session-recovery
  assertions passed.
- Additional browser protocol, frame-health and native-preflight source checks
  passed. Viewer geometry, extracted-preview parity, Admin layout and console
  access checks also passed after the UI corrections. Portable and mocked
  checks are not Windows execution.
- Preview `/console` returned HTTP 200 after the managed workflow restart.
- Signed-in browser journey: real backend and real relayed WebRTC with an
  explicitly synthetic Agent. Two UI defects were found and corrected; the
  narrowly scoped fixed-flow result is recorded below.

### Observed browser transport and controls

Origin:
`https://bc130126-6f69-4f4a-994e-81fba25b0be6-00-20ejwsuzuyv7v.spock.replit.dev/console`.
The initial browser viewport was **1280 × 720**, on 8 November 2026 UTC.

The disposable owner paired a synthetic device through the actual UI and public
Agent endpoints. Inspect, redeem, heartbeat and session consent returned HTTP
200; the session was not forced active through SQL. A pre-existing offline
device was left untouched.

- Viewer/gateway diagnostic protocol: **2 / 2**.
- Cloudflare TURN was configured, and the actual selected pair independently
  reported **relayed, srflx / relay, UDP**.
- Signaling was stable, connection and ICE connected, with command, files and
  clipboard channels open.
- At a 67.9-second producer observation, 679 synthetic frames had been generated;
  one offer and no replacement peers had been observed.
- Across recorded samples, received bytes advanced **83,160 → 254,543**,
  decoded frames **191 → 641**, and presented frames **206 → 649**. The final
  sample reported zero dropped frames. These samples are not a production
  throughput benchmark or a 20-minute Windows stability test.
- A 12-second intentional pause retained the peer; resume returned to video
  without a new offer.
- View-mode click/key attempts did not reach ordinary Agent input. Take control
  remained pending until matching simulated permission and curtain receipts.
- The actual End sharing UI produced an exact matching `ended` session and
  authorization in a subsequent HTTP 200 heartbeat. Errors alone were not used
  as completion evidence.

The live missed-realtime-answer experiment is **inconclusive**: the interceptor
suppressed zero answers. Catch-up reached 10 successful checks (one reported
177 ms), but this does not prove the answer arrived through catch-up instead of
realtime. The isolated actual-wrapper regression does prove that recovery path.
Intermittent resource-load 503s also occurred during the browser run; the
underlying production latency cause remains unconfirmed.

### Fixed-flow recheck

**PASS**, using the same synthetic device with a new UI-created, consented
session. This was a targeted check of the discovered faults, not another full
suite.

- At **1280 × 720**, ordinary Escape and F8 each cleared the actual pointer lock
  without a browser-API workaround. Each release delivered `release_inputs` to
  the synthetic peer.
- A 12-character typing-tunnel entry retained focus and its echo across a
  **seven-second** wait spanning background refresh. Twelve live `unicode_text`
  messages arrived, Type delivered one replay, and Clear emptied the field.
- At **402 × 874**, the same controls remained reachable by scrolling without
  video overlap. Three live text messages and one Type replay reached the peer;
  Clear worked. Desktop and mobile screenshots were inspected.
- Explicit Release control + curtain produced matching `mode=view`,
  `curtain=false` and applied `curtain_off` receipts. End sharing then produced
  an exact matching HTTP 200 ended heartbeat and disconnected the peer.

The synthetic harness was stopped and the disposable fixture cleanup completed
successfully. This does not certify any physical Windows input or curtain effect.

### Button and action matrix

“Protocol” below means source/isolated testing or an explicitly simulated Agent
receipt, not an observed Windows action. No Windows device was designated during
this review.

| Control | Current verification boundary | Actual Windows effect |
| --- | --- | --- |
| Open live session | PASS: real UI pairing, consent, authorized session and relayed video | Blocked |
| Fit / 1:1 | PASS: both browser display states changed | Not a native action |
| Fullscreen / collapse details | PASS: enter/exit and collapse/restore observed | Not a native action |
| Connection diagnostics / Copy diagnostics | PASS for displayed selected-pair/counters; export allowlist checked in code, clipboard export click not separately certified | Native encoder counters require Windows logs |
| Monitor selection | PARTIAL: simulated selection receipt arrived; synthetic metadata still displayed Display 1, so display change is not certified | Multi-monitor capture blocked |
| Reconnect viewer | Fresh generation/stale-reply isolation regression-tested; UI action not exercised in this run | Windows transport recovery blocked |
| Close viewer / reopen | Continuity requirement retained; UI reopen not exercised in this run | Native continuity blocked |
| Take control + curtain / Release | PASS: pending-to-matching simulated permission, curtain-on, view-mode and curtain-off receipts | Curtain coverage, capture exclusion and local input blocking blocked |
| Pointer capture | PASS after correction: real Escape/F8 release plus DataChannel input-cleanup receipts | Relative Windows input blocked |
| Typing tunnel / Type / Clear | PASS after correction: retained focus, real text receipts, and reachable controls at desktop/mobile sizes | Windows text injection blocked |
| Send clipboard | PASS: truthful queued toast and one real DataChannel receipt at the synthetic Agent | Clipboard application blocked |
| Record / Stop | PASS for recording/saving/idle UI transitions; helper checks cover interruption/save logic, resulting recording contents not independently inspected | Native recording parity blocked |
| Pause / Resume | PASS: 12-second pause and resume with no replacement peer | Windows recovery blocked |
| Privacy curtain renewal / escape | Correlation and bounded lease preserved in source/protocol | Local emergency escape, lease expiry and unsafe-capture release blocked |
| Send/receive files | Control visible; transfer not exercised. Interrupted transfer is not proof of completion | Full native file integrity remains unverified |
| Windows unlock / PIN / secure attention | Unavailable/disabled readiness state observed; no unlock/SAS attempted. Sequential backoff covered by isolated tests, browser polling cadence not certified | Secure desktop, saved PIN, SAS and cancellation blocked |
| End sharing | PASS: UI closed the viewer; exact matching ended heartbeat and peer disconnection observed | Pairing-window behavior requires Windows |
| Revoke access | Control observed, not activated; authorization regression checks do not certify the UI journey | Physical stop/cleanup blocked |
| On-screen keyboard / trackpad | Same control gates retained; not exercised in the initial browser journey | Windows key/mouse injection blocked |
| Quality/performance controls, if available | Not exercised; negotiated codec/path is not encoder-output evidence | Windows encoding effect blocked |

Native Admin inventory additionally includes **Reconnect Agent, Restart stream,
Restart Agent, power menu, Copy stats, Windows PIN settings, Cancel unlock,
file-list refresh, delete, Send files, unlock ZIP downloads and Download ZIP**.
These are separate actions, not aliases for the browser's Reconnect button.
Native Admin was not built or run. Destructive power, file deletion and
secure-desktop actions were not tried on a customer device.

The separately tracked incomplete HTTP file-assembly work and
Watch/companion-authorization outage-test work remain open; this review does not
claim to have implemented or completed them.

## Cloudflare findings and architecture comparison

The existing Cloudflare integration was used read-only. Account discovery and
the documented TURN GraphQL query returned HTTP 200 without GraphQL errors.
The account-wide date-filtered query for **7–8 November 2026 UTC** returned no
usage groups. It was not attributable to a particular ConnectLive TURN key.
**An empty result is not proof that this application never used TURN.**
This query preceded the controlled relay test. Ownership of the production
TURN key by the connected account was not established; account-wide results
must not be presented as application-specific telemetry.
No resources, DNS records, keys or cache settings were changed.

Official TURN analytics describes ingress/egress bytes and concurrent
connections. These metrics cannot reveal decrypted video or prove that a
browser rendered a frame. Correlate a known key/time window with selected-pair
and frame evidence instead of treating aggregate traffic as playback proof.

| Option | Relevant benefit | Cost, compatibility and safety consequence | Recommendation |
| --- | --- | --- | --- |
| Supabase + current TURN | Preserves the existing authorization, SQL, realtime and storage model; fixes can be isolated | Requires actual gateway/DB timing and native codec/transport evidence; normal DB and relay operating costs remain | Keep now |
| Optional edge session coordination | Could reduce signaling latency and maintain a live connection for coordination | New service/state lifecycle, native reconnect handling, operations cost and a revocation/fencing design; must not serve stale authorization | Consider only after measured signaling bottlenecks |
| Optional Realtime SFU | Server-mediated publication/fanout and provider-side session/track observability | Different signaling/track/DataChannel integration, native interoperability work and media/bandwidth costs; review provider-terminated media trust and any end-to-end encryption requirement | Separate prototype only if justified |
| D1 database migration | SQLite-compatible managed storage for a separately justified storage design | Not ICE, TURN, an encoder or a renderer; PostgreSQL functions, RLS, auth, realtime, storage and data migration require redesign; rollback/data reconciliation would be substantial | Do not use as this video repair |

TURN relays encrypted WebRTC traffic; moving to an SFU is not automatically the
same media privacy model. Neither an SFU nor D1 can make a failed local encoder
produce frames.

### Next acceptance gates

1. On a designated Windows test device, build the complete 1.10.9 source and use
   the same approved preview origin as the updated browser. Verify at least
   20 minutes of actual moving video, idle/resume, forced relay and network loss.
2. Physically verify curtain coverage while the technician still sees the
   desktop; local input blocking; release; emergency escape; lease expiry;
   unsafe-capture fallback; explicit end-to-new-pairing behavior; and native
   Admin compatibility. A simulated receipt cannot satisfy these gates.
3. Obtain authorized read-only Coolify/gateway and database timing evidence.
   Correlate the actual deployed revision, slowest request stages, CPU/memory,
   connection/network latency and query performance. Choose any production
   rollout or infrastructure experiment separately.

### Official references

- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/realtime/turn/analytics/
- https://developers.cloudflare.com/realtime/turn/faq/
- https://developers.cloudflare.com/realtime/sfu/concepts/architecture/
- https://developers.cloudflare.com/realtime/sfu/observability/

## Source delivery

`ConnectLive-Agent-1.10.9-Source.zip` contains the complete source, required
shared sources/tool manifests and manual build instructions. See
`agent/RUN-SOURCE.md` and `agent/VIDEO-DEPENDENCIES.md`.

Archive SHA-256:
`625bf8e2745451112f7c8cc40c41093103fb134ea7ab2884ffac7eaa83902d8f`.

This archive is a source candidate, not a tested Windows executable. Receiving
it does not update the production website, gateway or an installed Agent.
