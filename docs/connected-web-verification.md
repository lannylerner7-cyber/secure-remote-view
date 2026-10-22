# Connected web application — 2026-10-22

The root web artifact now runs the imported TanStack Start application in
`imports/connectlive`. The earlier disconnected frontend remains in the
artifact folder as source reference but is no longer the dev/build entry point.
The artifact explicitly routes `/api/public` to the full web service so the
scaffold API service cannot intercept those requests.

## Completed

- Registered imported package in the pnpm workspace and installed dependencies.
- Production Node-server bundle builds; framework deprecation/peer warnings
  remain and are not reported as a clean typecheck.
- Vite listens on injected PORT, all interfaces, strict port, proxied hosts.
- Root service exposes `/health` and `/api/public/health` (both HTTP 200).
- Both distinct admin sign-in pages return HTTP 200.
- Unauthenticated `/api/public/agent/ice` returns HTTP 401.
- Cloudflare provider calls have a shared five-second deadline including
  response parsing, cancellation propagation, sanitized logs, and validated
  ICE results. Legacy endpoint fallback is limited to 404/405.
- 13 isolated gateway tests pass, including stalled requests/bodies,
  cancellation, rejected access, credential shapes and fallback handling.
- Sign-in POST has a 20-second browser deadline without automatic retries.
- Browser verification: required-field validation, one synthetic invalid login,
  visible rejection and recovered button state, signed-out console protection,
  and separate technician/payment login pages.
- Signed-out payment-route redirect now selects payment login rather than
  technician login. No successful login was attempted.
- Replaced an unavailable Lovable-hosted homepage animation reference with the
  existing local brand illustration. Other legacy hosted assets may still need
  to be supplied; no animation was regenerated.
- Built public output was scanned against configured private credentials; zero
  matches. No secret values were logged.

## Limits and next setup

The intended initial administrator has now been provisioned with the
super_admin role and its profile verified. A POST through the application's
login endpoint returned HTTP 200; a subsequent role query using that user's
access token passed RLS and returned super_admin. The API test session was
logged out successfully (HTTP 204). No password/token was logged.

Successful browser login, real role-specific data views, authorized native
sessions and file transfer remain unverified. The browser harness could not
access the injected setup password and therefore did not attempt sign-in.
Do not describe API authentication as verified browser session persistence.
No email was sent or remote session started. One earlier synthetic failed
login created the expected failed-attempt record.

SMTP authentication and direct Cloudflare credential generation had already
passed separate provider checks. Neither proves mail delivery, TURN allocation,
or Windows rendering latency. The payment replacement is still incomplete.

No Coolify environment values or published deployment changed. The production
artifact uses the imported Node-server bundle, not static SPA serving.
Workspace configuration and Coolify configuration are separate.

The browser tester observed a caret-style hydration warning and TrustedHTML/
WebGPU warnings; the subsequent login-page screenshot showed no such console
errors. Do not claim those intermittent warnings have been root-caused.
