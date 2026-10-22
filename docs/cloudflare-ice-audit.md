# Cloudflare / ICE audit — 2026-10-22

## Remediation update

The five primary source defects below have now been addressed in the current
web/native code; the body preserves the original audit evidence.

- Gateway requires a UUID sessionId, active session and valid view grant.
  Devices must match the session; users need technician/admin/super_admin role
  and session ownership unless super_admin. DB/auth errors fail closed.
- Gateway authorization has a four-second response budget, followed by the
  existing five-second provider budget. Native/browser total budgets are 12s.
  Underlying auth DB operations may finish after their response deadline, but
  cannot proceed to mint credentials after that timed-out request.
- Gateway limits to ten mint attempts/minute/principal per process, with bounded
  tracking and no-store 429/Retry-After. This is not a cluster-wide quota; a
  shared edge/distributed limit is still required for replicated deployments.
- Browser now binds before ICE, guards late async completion, refreshes on
  expiry/restart, and bounds fallback retries.
- Agent refreshes for each new offer/peer; Admin retains negotiation refresh.
  Both pass sessionId, validate HTTPS origins and refuse HTTP redirects.
  Admin's old embedded Supabase defaults were removed. Public deployment config
  must be supplied before packaging; no private key belongs in client config.

Evidence: 16 gateway tests, 17 browser ICE scenarios, 13 browser recording
regressions, 22 portable native tests, web production build and both explicit
Windows-targeted builds pass. Live app now rejects anonymous requests (401),
missing sessionId (400) and nonexistent sessions (403), all with no-store.
No active session was manufactured for a live mint test. The earlier successful
super-admin mint without sessionId is intentionally no longer permitted.

The app restart and login screenshot succeeded. Development logs still include
aborted-request/ECONNRESET entries during startup and existing framework
deprecation warnings; these were not counted as passing end-to-end stability
tests or claimed to be resolved by ICE work.

Remaining: real Windows relay/media tests, native release configuration,
distributed rate limiting, and the legacy static-coturn TTL semantics below.
Static coturn is not configured in this deployment; its legacy ttlSeconds field
is a client refresh hint, not proof that static credentials expire. Cloudflare
and coturn REST credentials do have expiry.

## Scope and evidence

Cross-reference search and targeted inspection covered the current imported
web application, C# Agent/Admin, configuration/build scripts, and extracted
client archives. Generated build output and dependencies were excluded from
source searches. This is not proof that every possible runtime path is correct.
Archived builders are historical references, not the source currently built.

Live checks through the running web app, using an authenticated super-admin:

| Request | Result |
| --- | --- |
| Authenticated ICE | HTTP 200, turn=true, valid relay entry, no-store |
| Credential request duration | 406 ms for this one request; not media latency |
| Reported credential TTL | 43,200 seconds (12 hours) |
| Anonymous ICE | HTTP 401 |
| Invalid bearer ICE | HTTP 401 |
| Test-session logout | HTTP 204 |

All 13 isolated gateway tests passed. They exercise the actual route with mocked
provider/auth dependencies. They do not prove role enforcement, actual relay
allocation, Windows media delivery or load capacity. Credentials were neither
printed nor persisted by these checks.

## Findings requiring work

### 1. Authentication is not sufficient authorization for paid relay use

`imports/connectlive/src/routes/api/public/agent/ice.ts` verifies a bearer user
with getUser, but does not require a technician/admin role, owned authorized
session or entitlement. Device verification checks credentials, not a current
viewing grant. There is no mint throttling. Any authenticated account can request
billable relay credentials repeatedly. Add explicit role/session rules compatible
with authorized client startup and test allowed/denied roles and revocation.

### 2. Native deadline is shorter than the complete server budget

Agent `src/WebRtcSession.cs` and Admin `src/Media/WebRtcClient.cs` allow five
seconds for the entire ICE HTTP request. The web gateway allows the provider
five seconds *after* authentication work. Clients can abandon a response before
the gateway returns coturn fallback. Align end-to-end budgets and cancellation;
test a slow provider with a working fallback. This mismatch exists after the
earlier startup-race fix and should be corrected before claiming reliability.

### 3. Stale credentials on browser/Agent reconnect

Agent caches its ICE warmup task for the session; its deserialized TTL is unused.
Browser `src/lib/webrtc-live.ts` also fetches once and reuses configuration on
ICE restart. An initial STUN-only fallback or expired credentials can persist.
Refresh before new allocation/restart as appropriate. Native Admin already
refetches on negotiation; do not incorrectly describe its restart as this same
cache defect.

### 4. Browser connection startup can outlive failure/close

`src/lib/webrtc-live.ts` has no explicit end-to-end deadline on the ICE fetch.
Its watchdog can report failure before the awaited fetch completes, and kickoff
lacks a closed-state check immediately after that await. Add cancellation and
generation/closed guards to prevent late offers from abandoned startup.

### 5. Native deployment configuration is not yet aligned

Admin `src/Api/AppConfig.cs` retains an older Supabase configuration fallback.
Executable-directory configuration takes priority over user configuration.
Both clients trust configured API origins; validate HTTPS and disallow userinfo
and unexpected credential-bearing redirects before sending tokens.
Do not assume configuring Replit or Coolify updates installed clients.

## Current behavior confirmed in source

- Both console and native clients call the application's ICE gateway.
- Cloudflare minting uses a TURN key ID, despite the legacy APP_ID variable name.
- Provider calls have one bounded deadline and honor incoming cancellation.
- Provider failure logs no longer include raw response bodies or tokens.
- Legacy mint fallback occurs only for HTTP 404/405.
- Provider response normalization requires credentials for relay URLs.
- Cloudflare failure falls back to configured coturn, otherwise Google STUN.
  STUN-only is not verified TURN connectivity.
- Success response is no-store. Each request mints credentials anew.
- Static coturn credentials, if configured, are not actually constrained by the
  common TTL field; report/refresh semantics need to distinguish that fallback.
- No D1/Workers dependency is required solely to make this one-to-one TURN path
  work. Do not add services as a substitute for fixing these paths.

## Remaining runtime verification

Use two authorized Windows devices to verify direct and forced-relay candidate
selection, cancellation, takeover, disconnect/reconnect, credential rollover,
and local stop/revocation. Measure capture, encoding, queueing, network, decode
and presentation separately. TURN credentials and DXGI capture availability
alone do not establish low-latency end-to-end rendering.

No application source changes were made during the initial audit. The remediation
above changed source afterward. No email was sent,
no remote session started, and no Cloudflare resources or Coolify values changed.
