# Browser ICE lifecycle hardening

## Implemented behavior

- `startWebRtcLive(sessionId)` keeps its public interface. ICE is requested only
  after `bindAdmin` succeeds (which verifies the current viewing authorization),
  with this session in `/api/public/agent/ice?sessionId=...`. There is no
  pre-consent ICE prefetch. Recording authorization and capabilities are unchanged.
- A 12-second end-to-end deadline covers token lookup, gateway transport and JSON
  parsing. This leaves room beyond the gateway's five-second provider budget for
  authentication and server fallback. Abort races also bound dependencies that
  ignore cancellation. Request credentials are no-store and redirects are denied.
- Close, takeover, terminal failure and startup rejection invalidate pending work.
  Guards run after binding, configuration fetch, offer creation and local
  description. Late completions cannot configure a closed peer or enqueue offers.
  Close tears down locally without waiting for the best-effort final `bye`.
- TURN configuration refreshes before its reported `ttlSeconds` expires, with a
  20% safety margin capped at 30 seconds. TTL age starts before the request.
  Missing/invalid TTL uses 60 seconds conservatively; values over one day are
  capped. Refresh updates future allocation configuration without interrupting
  working media. Every actual media/ICE restart fetches again before its offer.
- A failed refresh removes previous TURN configuration and reports direct-only,
  rather than silently reusing expired credentials. Transient failure/STUN-only
  results permit one delayed retry per live view, not perpetual outage timers.
  Restored TURN on that retry triggers ICE gathering. HTTP 429 delays that retry
  60 seconds; successful TURN renewal schedules the next expiry refresh.
  Authentication/session denials (400/401/403/404) terminate negotiation without
  a direct-path authorization bypass.
- The initial ICE progress watchdog starts after the offer, not during credential
  lookup. It is suspended during the bounded fallback retry. Media watchdog
  recovery cannot race its own pending negotiation.
- ICE errors log fixed diagnostic categories, never transport exceptions,
  gateway bodies, credentials or tokens. `relay()` reports configured relay
  availability, not proof of a selected relay candidate.

## Verification

Run `node scripts/browser-ice-check.cjs`. The test transpiles and executes the
actual `webrtc-live.ts` wrapper with mocked browser APIs, auth, signaling and HTTP;
no external credentials or real relay allocation are used. Scenarios cover
session-scoped requests, cancellation during binding/fetch, ignored abort,
stale offers/local descriptions, end-to-end timeout including auth/body parsing,
slow gateway fallback, bounded retry, expiry refresh/failure, media restart,
grant denial, rate limiting, rejected configuration and secret-safe diagnostics.

`node scripts/browser-recording-check.cjs` also remains passing, preserving the
existing recording authorization/revocation checks.

These are deterministic mocked-transport checks, not evidence of a real browser
relay allocation, Windows interoperability, candidate selection or media latency.
The gateway's session/role policy remains authoritative: an account that can
bind through a legacy policy but is denied by the hardened ICE route now fails
startup explicitly instead of negotiating around that denial.
