# ConnectLive source and desktop-package review

## Decision

**Hold production release of these desktop packages and do not claim end-to-end
payment safety.** Archive integrity passed; source/runtime contracts have
release-blocking defects. This audit did not fix those defects, replace ZIPs,
push GitHub, mutate production data or deploy.

Three parallel examinations were followed by one independent second-pass
review. The findings below are reconciled conclusions, not unfiltered counts
from overlapping reports.

## Baseline and coverage

- Baseline source revision: `851881d26523ce2140d310b193662c5973a1556a`.
- `baseline.json`: 761 tracked files, presence/size/hash and starting local changes.
- `coverage-ledger.json`: 867 entries including generated files/subtrees supplied
  by reviewers: **210 statically reviewed, 558 automatically checked, 97
  excluded with reasons, 2 blocked**. Every baseline file has an entry.
- An automatic hash/inventory is **not** a semantic review. This is not a claim
  that every line or possible runtime behavior has been exhaustively verified.
  The blocked items are the environment template inspection and fresh-installer
  execution/review limitation recorded by the backend reviewer. Existing
  metadata checks imported only the installer's read-only helper functions;
  the installer was never run.
- `excluded-trees.json` lists 36 generated/dependency/tool-state tree roots.
  Historical client-builder archives and unused scaffold code are not silently
  represented as tested current runtime.
- `route-index.json`: 45 route declarations and 83 literal references. Literal
  references can be comments, declarations or interpolated fragments, not live
  requests. All 45 declarations appear in the generated route tree.

### Detailed evidence

| Area | Report and coverage |
| --- | --- |
| Agent, capture/input, installer/updater, Agent package | agent-review.md; agent-coverage.json |
| Native Admin, sign-in/RTC/files/lifecycle, Admin package | admin-review.md; admin-coverage.json |
| Web consoles, API/SQL/payment/deployment | backend-review.md; backend-coverage.json |
| Independent challenge and scope corrections | second-pass.md |
| Archive/PE/config/hash checks | package-verification.json |
| Coordinated command outcomes | check-results.json; check-1.log through check-11.log |

## Priority findings

| Priority | Finding | Evidence / affected path |
| --- | --- | --- |
| Blocker | Agent ZIP launcher saves configuration before creating its directory; fresh-profile launch can fail before enrollment | Agent finding 1; independently confirmed startup/SaveConfig ordering |
| Blocker | Native first negotiation can stop on active-only ICE rejection before consent; no consent-triggered RTC retry | A10-02; native video affected, independently running JPEG fallback is a separate path |
| Blocker | Native datachannel sender flattens inputs while Agent requires nested payload; coordinates/keys do not reach the expected parser | A10-03; kind-only commands are not all affected |
| Blocker | Web/native view-to-control and paused reconnect actions conflict with installed session guards | A10-01 / B03; preserve guards and implement supported invitation/recovery flows |
| High | Sign-out leaves live peers/windows; shared transports and old-window teardown can affect other sessions or a takeover replacement | A10-05/06/07; Windows reproduction still required |
| High | Public email-only lookup returns private delivery links; returned order IDs also enable public buyer/order detail lookup | B01 plus second-pass finding; no real customer lookup was attempted |
| High | Signed webhook still matches shared wallet by address and allows non-monotonic, insufficiently validated order updates | B02; not a claim that an unsigned attacker can forge the webhook |
| High | Selected-monitor input is mapped across the full desktop | Agent finding 2; multi-monitor runtime not exercised |
| High | Installer product detection/uninstall identity and standard-user update/handover paths are inconsistent | Agent findings 3–5; portable ZIPs are not these installers |
| High | Ordinary Admin build scripts package blank required configuration | A10-13 / B04; **does not apply to the separately configured delivered Admin ZIP** |
| High | Replit deployment exclusion omits imports while runtime points into imports/connectlive | Backend deployment finding; distinct from Coolify context, not changed during audit |
| Medium | Native inbound files and unpublished server chunks lack complete bounded admission/integrity behavior | A10-10 / B09; no large payloads sent |
| Medium | Presence/SSE polling cadence, failure handling and per-connection query load disagree with status expectations | B07; projection, not a fleet benchmark |
| Medium | hello acknowledges failed writes; stopped beacon uses severity rejected by schema | B06; no successful device write attempted |
| Medium | Payment reconciler error/expiry/history/email paths remain incomplete | B08; no actual payment processed |

Reports contain further retry, refresh, codec, document-drift, updater/version
and dormant Watch findings. They are not omitted from the ledger simply because
they do not appear in this priority table.

## Reconciled caller/state matrix

The detailed matrices in agent-review.md, admin-review.md and backend-review.md
record actual methods, payloads, credentials, responses/errors, retries/timeouts
and unmatched/unused paths. This table connects their state conclusions.

| Journey | Current contract and mismatch |
| --- | --- |
| Enrollment / device hello | Enrollment creates a device identity; hello requires device headers and reports presence, not Windows login. Write results are ignored in hello. |
| License / recorded permissions | View, control, clipboard, files and recording are separate scopes. Headless enrollment/foreground activation has an incomplete binding path; legacy identities are not consent evidence. |
| Invite → active | Recorded authorization is required. Native RTC starts before this boundary may be satisfied and does not retry denial after consent. |
| Active view → control | Direct client mode escalation is forbidden by supplied and installed guards. Existing web/native UI still tries it. |
| Pause / reconnect / end | Transport recovery of an already active authorized session differs from reopening a paused session. Current UI conflates these; direct paused→active is rejected. |
| Signaling / takeover | Session/admin identity binding exists, but old-window teardown is not consistently constrained to the current owner. |
| Input | Separate control permission exists; native DC payload shape and REST printable-text kind disagree with receiving parsers. |
| Files / recording | Scoped authorization checks pass in mocks; streaming/resource/integrity gaps and concurrent-window transport ownership remain. |
| Presence / wake | SSE accelerates selected commands via per-stream database polling; idle heartbeat and web presence thresholds disagree. |
| Payment/order admin | Unique quoted amounts do not protect the older address-only webhook path; privileged UI gates do not by themselves constrain direct table mutations. |
| Updates / install / uninstall | Portable package, installer, updater, watchdog and roster presence are distinct contracts; current docs/scripts overstate their parity. |

## Packages: what is proven

Both delivered ZIPs are unchanged, CRC-valid, free of duplicate/path-traversal
members in this inspection, and match their recorded manifest and per-file
SHA256 values. Every payload member is checksummed. Both EXEs are x64 PE32+
Windows GUI programs with zero Authenticode certificate-table bytes, and match
their original published staging files.

| Archive | SHA256 |
| --- | --- |
| ConnectLive-Agent-Windows-x64.zip | `3e3ec2ad6a67a6ccbec99c6a2d6156e36f82bfa5882e26dfb12bd687f1f9e512` |
| ConnectLive-Admin-Windows-x64.zip | `b75464c72b277ea2fdda203e07debcbe9ce73e9b17aba33950b0c0b9a9b5a908` |

EXEs contain version hints 1.9.1 and 1.7.2, both with source revision
`63b9f3d5b4ace4df33430547a109c9964a41f061`. Git comparison from that revision to
the review baseline found no changes under Agent/Admin source directories.
That and matching staging hashes support correspondence, but **do not attest a
reproducible build or exclude uncommitted build inputs**. No replacement build
was used to silently change what the user downloaded.

Admin package fields/origins and publishable-key format were inspected without
printing its value. Source template remains blank for required Supabase fields;
the special desktop packaging script supplies the generated public settings.
Native dependencies are bundled in a self-contained single file; their Windows
loading/codec compatibility was not tested. No MSI, Watch or startup service is
included. Portable README warnings are not proof of successful Windows startup.

## Checks run and their limits

- Ten isolated/portable command groups passed, including 44 server, 18
  recorded-authorization, 17 browser ICE, 13 browser-recording, 22 native policy
  checks and the additional file/payment/config checks recorded in the logs.
- Additional local-withdrawal tests: **14 passed**. Portable grant assertions:
  **54 passed**. These do not instantiate the Windows UI/media stack.
- Production web Node bundle built successfully. No app behavior was modified.
- Live Supabase audit ran read-only and exited **2**, intentionally reporting
  audit_logs absent from the realtime publication. Tables/columns/keys/guards/
  indexes and all 64 reviewed migration records/catalog fingerprint match.
  The reviewers' initial source-only SQL caveats are narrowed by this separate
  metadata evidence; no active-session JWT/RLS mutation journey was exercised.
- Public API health returned 200 and anonymous ICE/hello returned 401.
  Python's default HTTP client received 403 for /health and login pages while
  curl returned 200 for the same URLs. Record this client-dependent behavior,
  not universal availability or a diagnosed Cloudflare rule.
- No real device enrollment/control session, payment, customer lookup, Windows
  Hello bypass, private data extraction, load test or production mutation ran.

## Required next steps

1. Fix fresh-profile packaging/startup and verified install/update paths; then
   rebuild new clearly versioned archives and test on authorized Windows hosts.
2. Repair client/backend session, input and teardown contracts without weakening
   recorded permissions. Test initial consent, two simultaneous windows,
   takeover, logout, pause/new invitation, local revocation and reconnect.
3. Protect buyer delivery/order access and unify payment acceptance around
   exact quotes, provider identity, idempotency and monotonic transactional state.

Windows acceptance remains a release gate: direct and forced TURN, DXGI
first-frame/encode/decode measurements, multi-monitor/DPI, lock/UAC/unlock,
files/recording, disconnection and standard-user update. Docker/Coolify runtime,
SSE proxy settings, signed installers and fleet capacity also remain unverified.
