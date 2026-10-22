# Cloudflare service boundaries

Official documentation reviewed on 2026-10-21:

- [Realtime TURN](https://developers.cloudflare.com/realtime/turn):
  relay traffic when direct WebRTC connectivity cannot be established.
- [Realtime](https://developers.cloudflare.com/realtime):
  SFU media forwarding is distinct from TURN relay connectivity.
- [Health Checks](https://developers.cloudflare.com/health-checks):
  probe origin-server/application availability and notify about failures.
- [D1](https://developers.cloudflare.com/d1/):
  managed SQLite-semantics database with Workers/HTTP access.

These descriptions do not provide an endpoint wake/keep-awake API. Health checks
can monitor a hosted API; they cannot establish that an offline Windows endpoint
is installed, awake, authorized or rendering frames. Missing heartbeat is not
proof of uninstall.

No additional Cloudflare product is justified solely by rendering delay. First
measure capture, encode, queueing, transport, decode and presentation separately
after authorization/runtime verification. TURN helps connectivity; an SFU is not
automatically required for a one-to-one session.

The imported code depends on Supabase database/auth/realtime/storage. D1 is not
a drop-in replacement for that combination. Do not migrate the database or
provision services based on the user's mention of D1 alone.

## Configuration check — 2026-10-21

**Current result: credential generation verified.** After configuring the TURN
key and associated token, the documented `generate-ice-servers` endpoint returned
HTTP 201 with valid short-lived relay credentials and UDP, TCP and TLS relay
URLs. The verification requested a 300-second lifetime and did not print or
persist the returned credentials. No relay traffic or remote session was tested;
this does not establish Windows connectivity or rendering latency.
Coolify still needs its own runtime configuration.

### Earlier diagnostic findings (resolved credential-generation blocker)

TURN configuration was supplied through workspace secrets. Both the documented
`credentials/generate-ice-servers` endpoint and the existing application's
`credentials/generate` fallback returned HTTP 404. Neither returned usable
relay credentials. No remote session or relay traffic was started.

This does not establish that the token alone is invalid: verify that the supplied
identifier is a TURN key ID (not an SFU app ID), that the key still exists, and
that its associated token belongs to it. Do not treat STUN fallback as successful
TURN configuration. Coolify configuration remains separate.

After replacement credentials still returned HTTP 404, a read-only check through
the authorized Cloudflare management connection listed one accessible account.
Its `/calls/turn_keys` endpoint returned HTTP 200 with **zero TURN keys**.
This establishes absence only in that accessible account; it does not establish
which account the supplied secret values came from. Create a TURN key in the
intended account or confirm access to the account that already owns it before
requesting another credential replacement. No Cloudflare resources were created.
