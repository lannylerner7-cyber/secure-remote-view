# Staged server recorded-authorization implementation

This changes only inactive imported server/web source and SQL. Nothing was
activated, deployed, migrated, connected to an external database or configured
with production credentials.

## Implemented boundaries

- Device-token-authenticated GET/POST `/api/public/agent/authorization` and POST
  `/api/public/agent/authorization/revoke` implement notice version 1. Exact keys,
  boolean scopes, known modes and control-requires-view are validated. GET is
  non-cacheable. Database/RPC absence is an explicit error, never a legacy fallback.
- The new source-only migration `20261021003000_recorded_device_authorization.sql`
  records UUID, device, owner, endpoint attestation, notice version, mode,
  independent scopes, recorded time and withdrawal time. A unique partial index
  allows only one unrevoked grant per device. Owner identity comes from the bound
  license's `user_id`; unknown/unowned licenses cannot record a grant. No ownership
  or historical human permission is invented.
- Recording/replacing/revoking grants is service-role-RPC-only. Device identity is
  derived from the authenticated request, not supplied in the grant body.
  Replacement and withdrawal serialize on the device row, revoke old authority
  and end existing invitations/live sessions transactionally. Grant replacement
  does not rebind old sessions. Safety input rows are retained; stale frame,
  cursor, signal and non-safety input rows are removed during withdrawal.
- Heartbeat returns the strict authorization record. Only invitations permitted
  by a current grant and active sessions passing the authority RPC are surfaced.
  Presence, license status or `is_session_active` is not capture authority.
- Acceptance requires matching `authorizationId` and `noticeVersion: 1`, current
  view/control scopes, and a still-invited session. The existing conditional
  device/id/state comparison is preserved, including error/conflict handling
  before auditing success. It stores `authorization_id` and `authorization_mode`.
  Decline does not require an unrevoked grant. The existing invite model has no
  separate unattended request field: acceptance binds the actual grant's access
  mode. Attended per-session decisions remain the endpoint's responsibility.
- Frame, cursor, signaling, reconnect, file fallback and queued input handlers
  check authority. Inputs use an explicit known-kind/scope mapping; unknown kinds
  are dropped. `curtain_off` and `release_inputs` remain deliverable after end or
  withdrawal. Reconnect is still transport recovery only, not resume/activation.
- Web signal/binding server functions, file server functions and native Admin
  file HTTP routes require the appropriate active grant in addition to
  owner/super-admin identity. Role errors are not super-admin evidence.
- GET `/api/public/admin/session/$sessionId/authorization` is JWT authenticated,
  owner/confirmed-super-admin-only, non-cacheable and returns only:
  `{allowed, capabilities:{view,control,clipboard,files,recording}, authorizationId}`.
  It returns all-false scopes and null id for a nonauthorized session. Recording
  clients must check `allowed` **and** `capabilities.recording`, and periodically
  revalidate. It exposes no device token, grant owner or service credential.
- SQL restrictive policies AND recorded scope/state/ownership checks with all
  historical permissive policies for frames, cursors, signals, inputs and files.
  Write triggers recheck service-role channel writes too. Session/grant transition
  guards protect direct REST/RPC paths, reject client grant binding/activation and
  reopening closed sessions, reject active control escalation, and prevent
  invited/paused binding through the old binding RPC. End, pause, view downgrade
  where still authorized, and safety release remain possible.
- Database device-token metadata is protected from authenticated client writes:
  administrators cannot replace `token_hash` and impersonate the device's grant
  endpoint through ordinary device RLS. Session identity cannot be reassigned.
- Scope expansion requires another locally recorded grant; administrators have no
  grant-writing API/RLS privilege. There is no `standing_consent` or old
  `consent_at`-only fallback.
- Route registry, generated route declarations and relevant database function/
  session types were manually synchronized without adding a framework stack.

## Authenticated, revocable file byte proxy

Supabase signed download/upload bearer URLs are not immediately revocable with
session state. Their source paths are replaced with JWT-required
`GET/PUT /api/public/admin/session/$sessionId/files/bytes`. Prepare/download/package
operations return ordinary identifier-only URLs, not bearer capabilities.
JWTs travel only in the Authorization header. The migration still denies direct
authenticated access to the `session-files` bucket, preventing clients from
bypassing the proxy to mint storage tokens. Other buckets are unchanged.

Every byte request verifies JWT identity, owner/confirmed-super-admin, current
grant, files scope and active session. Uploads validate a flat session-bound path,
bounded actual body length, per-file and current session quotas, and do not
overwrite existing objects. Authorization is rechecked after body receipt,
immediately before storage upload and after completion. A detected revocation
causes staged-object cleanup and denial rather than success. Registration verifies
stored byte count, metadata, direction, transport, scope and quota before writing
the manifest; SQL also serializes manifest quota/duplicate/path checks.

Downloads accept manifest IDs, never arbitrary storage download paths. They check
all selected IDs belong to the same session, validate stored paths/sizes and
quotas, recheck before each storage read and before returning bytes, and use
attachment/no-store/nosniff responses. Encrypted ZIP downloads retain the existing
AES-256 password-wrapping/zip implementation: the proxy checks the cached password,
builds the selection on demand, rechecks authority and returns bytes without
creating an irrevocable signed ZIP link.

The browser now fetches both uploads and downloads with its current JWT and saves
downloads through local Blob URLs rather than window.open on a server URL. Native
Admin's existing upload method/`signedUrl` DTO names are retained for compatibility,
but contain only the identifier-only proxy URL. Its helpers enforce same-origin
proxy paths, attach the JWT and disable redirects. Its ZIP helper downloads the
authenticated response to a local encrypted `.zip` before the existing view opens
it, so no UI/model or recording-helper change is required. `CanRecordSessionAsync`
is preserved. Peer file transport remains a separate endpoint-enforcement boundary.

## Verification actually performed

`node scripts/recorded-authorization-check.cjs`: **18 checks passed** against the
actual TypeScript parser/helpers/handlers with an explicit in-memory database/RPC
substitute. Cases cover legacy denial, strict requests, device authentication,
correct/wrong/revoked grants, invited compare-and-update conflict, view/control/
file separation, input safety, revocation/idempotency, ended reconnect denial,
missing RPC denial, and Admin authorization identity/capability responses.

`node scripts/server-authorization-check.cjs`: **44 checks passed**, preserving
the earlier owner/reconnect/consent regressions with the real authorization helper
and explicit new grant/RPC fixtures.

`node scripts/file-proxy-check.cjs`: **25 checks passed** against the real proxy,
route and owner/scope helpers. Negative cases include absent/invalid JWT, unrelated
owner, revoked authority, wrong session/manifest/path, traversal, tokens in query
strings, missing RPC, per-file/session quota, revocation during storage operations,
metadata/size mismatch and missing ZIP password. Storage, JWT, DB and ZIP operations
are explicit test substitutes; this does not test actual encryption or storage.
The browser server functions and native prepare route are also checked to return
working identifier-only upload/download/package descriptors rather than tokens.

All 22 changed/new imported TypeScript files parsed without syntax diagnostics.
These are isolated source checks, **not** PostgreSQL execution, RLS verification,
SQL concurrency proof, semantic typechecking, browser tests or Windows tests.

## Uncovered integration paths and activation blockers

1. **The migration has not been applied or executed.** Existing databases retain
   their old direct REST/RPC/RLS vulnerabilities until independently reviewed and
   tested SQL is applied through an approved process. HTTP/server-function checks
   deny on missing RPCs, but cannot repair an unmigrated direct database API.
2. Peer WebRTC media, clipboard, input and files do not traverse these server
   channel gates. Windows/other endpoint receive-side enforcement, local matching
   grant persistence, cancellation/teardown and Admin recording stop are separate
   integration work; they are not verified or certified by this implementation.
   Unknown/old clients must remain disabled. Browser/local recording cannot be
   retroactively revoked after bytes have been delivered.
3. The wire contract attests through a device credential, not a separately
   authenticated named human. `authorizing_person` explicitly records that source
   and device identity; it is **not** proof of a named human's identity or UI
   presentation. If named-human evidence is required, extend the local enrollment
   contract rather than labeling a license owner as the person who clicked.
4. Unlicensed devices or licenses without a real owner cannot create complete
   grants. A reviewed owner-binding/enrollment flow is needed; absence must not
   be repaired by manufacturing ownership.
5. Already-issued signed URLs, already-delivered frames, in-flight responses and
   existing peer connections cannot be clawed back by server SQL. Previously
   issued storage tokens must expire or be invalidated operationally before any
   future approved activation; none were sought or issued here.
6. Storage service calls are outside the SQL transaction. Checks are repeated
   after body receipt, before storage operations and during assembly, and
   manifest writes are guarded, but a chunk/object upload already in flight may
   complete privately after revoke. The proxy attempts cleanup on detected
   withdrawal; failed cleanup/unregistered staged objects need orphan retention
   handling. Logical quotas count manifested live files, not every abandoned
   staged object. A buffered response already admitted by the final check may
   finish arriving after withdrawal, and downloaded local files cannot be erased
   remotely. Future requests are reauthorized and denied. Cancellation of
   already-admitted network bytes is not guaranteed.
   Upload/file/ZIP buffering retains the existing 500 MB/file and 5 GB/session
   ceilings; real host memory, body-size, request-timeout and native/browser
   behavior at those limits have not been exercised.
7. Device/session row locks are intended to serialize grant replacement, channel
   writes and transitions. PostgreSQL lock ordering, possible deadlocks (which
   must fail, not retry into activation), RLS/JWT behavior, realtime delivery and
   storage policies still require real isolated database/concurrency tests.
8. Service-role/database-superuser compromise is outside this boundary. Those
   credentials must never reach clients; no database policy protects against an
   operator deliberately bypassing trusted-server enforcement.

This is defensive staged source, not all-path remote-access certification.
