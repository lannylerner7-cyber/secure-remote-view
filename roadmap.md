# ConnectLive Android Agent — Head-to-Head Roadmap

Status legend: `[x]` implemented and verified in this repository/backend · `[~]` partial or code-only, not end-to-end verified · `[ ]` not built.

## Connection reliability update — 2026-10-22

### Email flows and templates

- `[x]` Shared order/newsletter/contact/booking/test templates corrected and
  synthetic renders checked; desktop/mobile browser layout review completed.
- `[x]` Reconciler confirmation dispatch, correct access-ready resend, paid-state/
  HTTPS guards, persistent send claims and truthful SMTP acceptance states.
- `[x]` SMTP cancellation, validation, sanitized errors, source precedence and
  newsletter unsubscribe/suppression checks covered with isolated tests.
- `[~]` Real provider delivery, sender-domain authentication and signed-in email
  settings interactions still require controlled verification. Existing booking
  email remains best-effort; in-app alerts were not converted to email.
- See `docs/email-verification.md` in the workspace for the full event matrix,
  test results and limitations. No production emails/settings/schema changed.

### Independent source/package review — release hold

The three parallel reviews and independent second pass are complete; see
workspace `docs/review/README.md`, the file-coverage ledger and detailed reports.
ZIP integrity and isolated tests passed, but **these packages are not certified
release-ready**. Earlier implementation/check marks below are scoped evidence,
not proof that the complete Windows journey works.

- `[ ]` Fix fresh-profile Agent launcher configuration-directory initialization.
- `[ ]` Reconcile native consent-to-RTC startup, input payloads, web/native
  control/reconnect state transitions and ownership-safe teardown/logout.
- `[ ]` Protect buyer delivery/order lookup and unify exact-quote, monotonic
  payment event handling; existing unique quotes alone are insufficient.
- `[ ]` Resolve multi-monitor input, installer identity/update handover and
  default source-build configuration before production packaging.
- `[~]` Coverage is explicit: reviewed, automatic-only, excluded and blocked
  files are distinguished. Windows runtime, reproducible package provenance,
  signed installers and fleet performance remain unverified.
- No product fixes, deployment, GitHub push or ZIP replacement were performed
  during this audit. Existing authorization boundaries remain intact.

### Pre-push deployment/database checks

- `[~]` Agent hello authorization review: six live missing/invalid-credential
  requests rejected with 401; 44 server, 18 recorded-grant and 22 portable native
  checks passed. Windows Hello/lock/unlock runtime is not verified. Hello write
  error handling remains a reliability finding. See workspace
  `docs/agent-auth-verification.md`.

- `[x]` Public production `/health`, `/api/public/health`, technician and payment
  login routes return 200; anonymous ICE returns 401. Built Node bundle repeats
  those results on explicitly overridden port 31317 (temporary process stopped).
- `[x]` Coolify Dockerfile uses the actual Bun text lockfile with frozen install,
  explicit public build arguments, Node 24, and a PORT-aware GET health check.
  Added missing `.env.sample`; expanded source/build secret and binary exclusions.
- `[x]` Read-only managed Supabase audit: 33 tables/RLS, 303 typed columns,
  33 validated foreign keys, 22 typed public relationships, 15 required indexes
  and 64 reviewed migration records match. Fixed missing generated types for
  device_authorizations and payment_quote_reservations.
- `[~]` audit_logs is not in the realtime publication; existing console polling
  updates it every five seconds. Live publication changes require a separate
  incremental deployment action, not rerunning the fresh installer.
- `[ ]` GitHub push is blocked on a usable workspace GitHub connection. Do not
  treat authorization metadata as proof that repository access/push succeeded.
- `[ ]` Container image build and actual Coolify proxy/SSE settings are not
  verified by the Node-bundle smoke test. No production deployment was triggered.

Full evidence: workspace `docs/database-release-alignment.md` and
`docs/pre-push-verification.md`.

This update supersedes the open **code defects** in
`docs/cloudflare-ice-audit.md`; it does not claim Windows runtime certification.

| Priority | Work | Status / evidence |
| --- | --- | --- |
| 1 | Session-bound relay permission | `[x]` Gateway requires sessionId, active state, view grant, matching device or technician/admin role plus ownership (super-admin exception). Anonymous 401, missing session 400 and nonexistent session 403 verified live. |
| 1 | Relay mint throttling | `[~]` Ten requests/minute per authenticated principal per process, bounded memory, 429/Retry-After, tests pass. Shared limits across Coolify replicas/edge still need deployment configuration. |
| 2 | Request budgets | `[x]` Gateway auth budget 4s and provider budget 5s; browser/native budgets 12s. Provider parsing/cancellation tests and native delayed-response/deadline checks pass. |
| 3 | Browser cancellation and renewal | `[x]` Bind first, then fetch; close/generation guards; TTL refresh and restart refresh; bounded fallback retry; no late offers after abandoned startup. 17 isolated scenarios pass. |
| 3 | Native renewal and takeover | `[x]` Agent fetches fresh settings for each new offer/peer; Admin refreshes each negotiation. Old-peer callbacks cannot act on replacements. Existing live peers are not forced offline at TTL expiry. |
| 4 | Native destination configuration | `[x]` HTTPS origin validation; no credentials/query/fragment; redirects disabled including SSE; old embedded Admin Supabase defaults removed. 22 portable checks pass. |
| 4 | Release configuration | `[x]` User confirmed https://connectliveagent.com; both portable Windows x64 ZIPs now packaged. Admin output includes validated public Supabase configuration; source template remains free of keys. No privileged keys or passwords bundled. See docs/windows-desktop-packaging.md. |
| 4 | Signed installers | `[ ]` Portable desktop verification ZIPs are unsigned, not setup/MSI installers. Signing and Windows installer verification remain separate. |
| 5 | Build/regression evidence | `[x]` 16 gateway tests, 17 browser ICE scenarios, 13 recording regressions, 22 native policy checks; web production build and both Windows-targeted builds pass. Existing native warnings remain. |
| 5 | Actual Windows direct/relay validation | `[ ]` Two Windows devices: selected relay candidate, first frame, DXGI/encode/decode latency, reconnect/takeover, expiry and local revocation. Linux compilation is not this test. |

Implementation detail and limits: `docs/browser-ice-hardening.md`,
`docs/native-ice-hardening.md`, and `docs/cloudflare-ice-audit.md`.
Portable desktop verification ZIPs were produced; no Coolify rollout, real remote session, or signed client release was performed.
Do not start Android media work by assuming these Windows runtime gates passed.

## Executive status

- `[x]` Windows is the existing production agent (`agent/`, C#/.NET) and the native technician app (`admin/`).
- `[x]` Backend now stores the explicit `devices.platform` discriminator (`windows` or `android`); `devices.os` remains descriptive OS/version text.
- `[x]` Web console has platform labels, release-version comparison, per-platform command UI, Android expected-device claim codes, and release-product selection.
- `[x]` Public enrollment validates platform, emits a device token, records the platform, and can bind a qualifying Android enrollment to an expected-device row using a one-use expiring claim code.
- `[ ]` There is no Android source project, APK/AAB, Android installer, live-install-progress reporter, Android heartbeat/SSE/WebRTC client, Android updater, or Android end-to-end test device in this repository.
- `[ ]` No Android release artifact is published/verified. The manifest API accepts `product=android`, but that does not mean an Android build or updater exists.

**Meaning of “installed” in the console:** it means the expected row has matched an enrolled device (hostname for Windows; successful claim for Android). It does not prove that an installer is currently running, that the app is still present, or that a current heartbeat is arriving. A truthful `installing` state requires installer/app telemetry; do not infer it from a click, pairing-code display, or elapsed time.

---

## 1. Existing Windows path — baseline to preserve

| Stage | Current Windows behavior | Android must not change it |
| --- | --- | --- |
| Installer and startup | Existing Windows installer/agent services, startup recovery and companion watchdog remain Windows-only. | No Android APK, service, command, or release may be routed into the Windows installer/update path. |
| Enrollment | Windows agent posts to `POST /api/public/agent/enroll`; omitting `platform` retains the database default `windows`. Meeting-ID license logic remains in force. | Android must send `platform: "android"`; do not infer platform from `os`, hostname, headers, or client version. |
| Device credentials | Server returns a per-device token; server stores its SHA-256 hash in device metadata. Windows protects the token with DPAPI. | Android needs a Keystore-backed equivalent; never reuse or expose a Windows credential. |
| Runtime | Windows heartbeat, SSE wake, sessions, signalling, WebRTC, TURN/ICE, input, clipboard/file paths, audit, and native Admin workflows are existing Windows paths. | Shared APIs may be reused only after Android request/response compatibility and device authorization are tested. |
| Updating | `product=agent` selects the Windows agent release. Existing Windows updater validates checksum. | Android must use only `product=android`, verify the package/signature/checksum, and never download or launch an `.exe`. |

---

## 2. Shipped shared contracts and guardrails

| Contract | Implemented now | Remaining caveat |
| --- | --- | --- |
| Platform | `devices.platform` is a closed `windows|android` column; old Windows callers default to Windows. | All new platform branches use this field, never `devices.os`. |
| Enroll | `/api/public/agent/enroll` rejects an unsupported explicit platform, keeps legacy Windows omission, and stores `platform`. | Public endpoint is IP-throttled; add Android-specific abuse tests and exercise from the actual app before release. |
| Android expected-device pairing | One-time eight-character code; claim code has a 24-hour expiry, is consumed on claim, and claim is limited to Android rows with matching license-owner identity. | A wrong/expired code does not block enrollment; it leaves the roster row unclaimed. Verify owner/license assignment in a real customer account before production APK onboarding. |
| Expected-device display | Windows hostname match; Android claimed-device match; version and last-seen data shown. | Current UI status is installed/not installed based on enrollment/association only; no real installation-progress signal exists. |
| Power command boundary | Shared TypeScript allow-list and a database trigger reject platform-incompatible command kinds. Windows retains its command set; Android presently allows only `lock`, `restart_stream`, and `restart_app`. | Android reboot is deliberately blocked until Device Owner provisioning and capability attestation are designed, tested, and enforced server-side. Android execution itself is not built. |
| Release boundary | Release table and `/api/public/agent/release` support `android`; device-authenticated callers are forced to their platform's product. | Android client/updater, package signature verification, download hosting, rollback, and a published artifact remain unbuilt. |
| Admin update indication | Web console reads latest published stable `agent` and `android` versions; device rows compare these with reported `metadata.agent_version`. | No actual Android version reports/releases exist yet. Verify stable/beta behavior and update execution once Android runtime exists. |
| Hostile input | Windows `InputRelay.Apply()` accepts a closed set, clamps numbers and text, and rejects free-form commands/scripts. | Android needs its own closed parser and tests; wire-schema parity must not mean permission to execute arbitrary commands. |

### Enrollment sequence and ownership

1. Technician creates an expected Android row; the console generates a random one-use pairing code that expires after 24 hours.
2. Android setup must collect the legitimate Meeting ID and the pairing code, with clear local disclosure and permission prompts. (No app exists yet.)
3. Server validates the Meeting ID/license and derives the license owner. Only a valid Android enrollment with a matching owner, unclaimed Android row, and unexpired code can consume the code.
4. Enrollment creates its device credential. Successful code use binds that device to the expected row and clears the code/expiry. A wrong or expired code may still create an enrolled device, but must not claim another user's roster row.
5. Console status means “agent enrolled and linked,” not “installer currently running.” Freshness/presence is shown separately from the roster match.

---

## 3. Android agent — implementation work not yet started

Target project path `android-agent/` is proposed, not present. Kotlin, min/target SDK, package ID, Play distribution, signing ownership, and MDM support require an implementation decision and real-device testing before being treated as settled.

### A. Product, trust and platform policy
- [ ] Define supported Android versions/device classes, distribution channel, app identity, signing key custody, privacy notice, technician authorization and customer consent/withdrawal flows.
- [ ] Separate normal-device and fully managed/Device Owner behavior. Do not claim Device Owner automatically bypasses MediaProjection consent; verify current Android APIs and target versions.
- [ ] Document every Android permission (screen capture, accessibility input, overlay, notifications, background operation) and provide a local stop/withdraw action. Do not hide capture or misrepresent it as user-approved.
- [ ] Verify Play policy and enterprise provisioning requirements before choosing Play Store, private managed Play, or sideload distribution.

### B. Install lifecycle and admin visibility
- [ ] Define server-side install states with timestamps and device/expected-row binding: `not_started` → `downloading` → `installing` → `first_launch` → `enrolled` / `failed`, plus timeout/abandoned states. States must come from signed/authorized installer or app telemetry, not an admin button pretending to be device progress.
- [ ] Define who can see and reset an attempt, whether retries keep the same expected row, and how failed attempts expire; add owner-scoped policies and audit events.
- [ ] Windows MSI progress is also not presently fed into this roster. Decide whether to instrument the MSI/bootstrapping service or keep Windows status as “enrolled/not enrolled.”
- [ ] Android client must report app version, updater state (`available`, `downloading`, `verifying`, `install pending`, `updated`, `failed`), previous/current version, and failure reason without leaking tokens. Android package-manager confirmation may require a user action or managed-device privileges; design both cases.
- [ ] Admin view must distinguish install progress, enrollment, reachability and update state; stale/offline is not the same as uninstalled. Add tests for transitions and timeouts.

### C. Capture, transport and sessions
- [ ] Foreground service with persistent user-visible notification; lifecycle behavior and battery constraints validated across supported Android vendors/OS versions.
- [ ] MediaProjection capture using Android's actual consent rules. Persist/reacquire only as the platform permits; handle revocation, app switch, screen lock, rotation and capture failure.
- [ ] MediaCodec H.264 first with tested fallback; validate negotiated codec, dimensions, frame pacing, orientation and native Admin decoder. “Hardware” is not assumed just because MediaCodec is used.
- [ ] WebRTC peer with ICE data from `/api/public/agent/ice`; test direct and TURN-only networks, reconnection, credential renewal, signalling isolation, and real Android ↔ Windows Admin sessions.
- [ ] Implement heartbeat, SSE wake and session signalling only after request/auth behavior is contract-tested against the existing routes. Android background limits may require a different reconnect strategy.
- [ ] Test viewport orientation, touch coordinate mapping and control latency against the actual native Admin client. Do not claim no-lag/zero-lag without measurements.

### D. Input and privacy controls
- [ ] Accessibility service for touch/gesture/text is opt-in and must explain its power. Confirm actions work only in supported contexts and stop immediately when permission is revoked.
- [ ] Keep a platform-specific executor for the existing closed event contract. Explicitly map each supported event; unsupported events are dropped, not reinterpreted. Add Android parser tests and input-boundary tests.
- [ ] Design curtain behavior from Android capture/overlay rules. A visible overlay is not proof captured content is hidden; verify on supported OS versions and do not promise that it prevents screen exposure until tested.
- [ ] Add independently testable local user stop, session end, lost-connection fail-safe, and permission revocation behavior.
- [ ] Encrypted file transfer and clipboard are not automatically compatible with Windows semantics; decide Android permissions and user-visible consent before implementing either.

### E. Power, MDM and reboot
- [ ] Implement `restart_app` only after lifecycle and re-enrollment recovery tests; Android background launch/alarm rules vary by OS and cannot be assumed to relaunch silently.
- [ ] Device Owner is optional enterprise provisioning, not a default consumer mode. Verify enrollment method, policy API availability, recovery/uninstall behavior, factory reset/ownership boundaries, and supported fleet workflows.
- [ ] Keep device reboot blocked in both UI and database until Device Owner status is proven by a trustworthy provisioning signal and an authenticated server rule. Client-supplied `metadata.device_owner=true` alone is not sufficient.
- [ ] No Android equivalent of the Windows watchdog is implemented. Do not claim `onDestroy` always runs or can reliably beacon after force-stop; test OS force-stop, swipe-away, process kill, reboot, Doze and vendor task killers. Show last-seen/offline when no reliable callback can arrive.

### F. Build, updater and releases
- [ ] Reproducible Gradle build, unit/instrumentation tests, signed APK/AAB, signing-key custody, SBOM/dependency checks, and documented installation/provisioning.
- [ ] Publish an Android package at an authenticated/controlled download location; create a published `android` release row only after artifact hash/signature and download are verified.
- [ ] Implement Android update checking against the manifest; enforce product/channel/version policy, verify digest and signer, safely install using supported Android mechanisms, preserve user data, recover/rollback after failure, and report state to admin.
- [ ] Verify release endpoint returns only the Android product to an Android device and Windows `agent` releases remain unchanged; test unpublished/204, stable/beta, bad checksum/signature, network interruption, and mandatory/minimum version cases.

---

## 4. Head-to-head platform separation matrix

| Concern | Windows agent | Android agent (target; not yet built) | Guardrail already in place |
| --- | --- | --- | --- |
| Platform identity | `devices.platform=windows`; legacy clients omit it and use DB default. | Must send `platform=android`. | DB check constraint; explicit API validation; shared `normalizePlatform`. |
| OS information | `devices.os` is free-form Windows build text. | `devices.os` should be Android version/build text. | Never use OS text as the platform discriminator. |
| Enrollment/credential | Meeting-ID licensing; DPAPI-protected per-device token. | Meeting ID + owner-scoped one-use code; Android Keystore token storage remains planned. | Enrollment API and unique expiring claim codes exist; Android client does not. |
| Installer progress | MSI install phase is not reported into expected-device roster. | No install-stage telemetry exists. | Roster reports current enrollment association only. |
| Update product | `agent` (Windows executable/package). | `android` (Android package). | Release API fixes product from authenticated device platform. |
| Version/update badge | Windows `metadata.agent_version` compared with latest stable `agent`. | Intended `metadata.agent_version` compared with latest stable `android`. | Web console release query/version comparison exists; no Android source/artifact to exercise it. |
| Power commands | Existing Windows kinds include wake/WoL, shutdown, reboot, lock/logoff, restart agent/stream and monitor switching (as supported by the Windows client). | Only `lock`, `restart_stream`, `restart_app` allowed for now. | UI shared allow-list + database trigger; Android reboot specifically rejected. |
| Input | `InputRelay.Apply()` sends bounded Windows inputs. | Accessibility-backed gestures; no Android code yet. | No free-form execution; input kinds and limits must remain closed. |
| Capture/control | Windows desktop capture and native Admin paths. | MediaProjection/MediaCodec plus accessibility permissions are planned. | Shared signalling/TURN is a possible transport reuse, not yet end-to-end verified. |
| Agent-stopped visibility | Windows companion Watch/beacon path exists. | No reliable Android shutdown beacon assumed. | Console must use last-seen/presence for Android, not claim a Watch process exists. |

### Shared transport reuse is conditional

Existing routes include enroll, heartbeat, stream/SSE, session signalling, ICE, file/session paths and power acknowledgements. They are currently built and exercised for Windows. Reusing the URLs does **not** establish that Android's authentication headers, payloads, lifecycle, retry cadence, accessibility semantics, WebRTC codec negotiation, or data channels work. Verify each contract head-to-head before declaring parity. Preserve `session_signals.admin_client_id` binding and test that unrelated admin peers cannot receive each other's signalling.

---

## 5. Verification gates — do not skip

1. **Backend contract:** test platform validation/default, license state, token verification, claim ownership, claim expiry/single-use, duplicate claims, bad codes, rate limits, audit result and no cross-owner roster disclosure.
2. **Windows regression:** existing MSI install/upgrade, DPAPI token, heartbeat/SSE, all current power commands, Windows release selection, signature/hash updater, and expected-device hostname behavior remain green.
3. **Android install:** clean install, permission explanation/accept/deny/revoke, install failure, first launch, install progress state, enrollment and owner-scoped roster transition.
4. **Android runtime:** supported OS/vendor matrix; background/Doze/reboot/force-stop; capture consent/revocation; battery; rotation; input; file/clipboard consent; restart; session end; offline last-seen.
5. **Cross-platform live session:** Android device to Windows Admin, real H.264/fallback decode, portrait mapping, direct ICE and TURN-only, reconnect, isolated signalling, consent and local stop.
6. **Updater:** test signed artifact/hash, wrong product rejection, stable/beta, staged/mandatory/min-version rules, interrupted download, install confirmation, rollback/recovery, and admin update status.
7. **Security and release:** no client-controlled admin/Device Owner privilege, no cross-customer pairing, no credentials in logs, dependency/signing review, and a published Android artifact only after all gates pass.

---

## 6. Active next sequence

1. [x] Correct platform identity and Android release product in the shared contract.
2. [x] Add one-use, expiring Android claim code and platform-aware expected-device display.
3. [x] Make web console read current published stable versions and show update-available comparisons.
4. [x] Reject Android reboot server-side until Device Owner attestation is designed; hide it in the web power menu.
5. [ ] Resolve ownership mapping and verify paired roster behavior with a real customer license/account (no matching live license rows were available during this review).
6. [ ] Decide the Windows MSI progress reporting contract and Android install/update lifecycle state model; implement telemetry only when clients can emit truthful states.
7. [ ] Scaffold Android app only after target API, permissions, signing/distribution, privacy/consent and device-management policy are settled.
8. [ ] Implement in gated slices from §3, then run the full §5 matrix on physical devices and a Windows Admin client.

## 7. Explicit non-goals until separately approved

- No iOS agent or browser-based control of physical devices.
- No hidden capture, bypassed OS prompts, root-only input, or unverified Device Owner/MDM claims.
- No Android “installing” badge based on guesswork; no fake percentage progress.
- No Android auto-update/reboot before package verification and Android OS install rules are implemented.
