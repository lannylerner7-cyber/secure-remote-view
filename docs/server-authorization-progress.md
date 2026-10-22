# Server authorization remediation

## Direct-transition follow-up

Added migration `20261021001000_guard_client_session_transitions.sql`.
For JWT-authenticated clients, it restricts inserts to unconsented invitations,
protects device/technician identity and consent timestamps, blocks direct
activation and control escalation, and prevents reopening ended/declined rows.
Pause, end and downgrade-to-view remain possible under existing RLS.
Device-authenticated server routes remain responsible for their own authorization.

**Not applied or PostgreSQL-tested.** Existing direct resume/control-escalation
commands will be rejected when this migration is applied until a recorded-grant
authorization path replaces them. The web control action now reports failure
before queuing curtain input or claiming success; native Admin already checks
its HTTP response. This migration must not be deployed alone as a completed feature.

The consent handler now rejects malformed decisions and conditionally updates
only the same device's still-invited session. Failed/raced writes return errors
without recording a successful consent audit entry. This does not replace the
still-missing informed local grant.

The isolated handler suite now passes **25 checks**, including these five new
consent cases. All 163 TypeScript files parse without syntax diagnostics.

## Changes implemented in staged source

### Admin binding

The web `bindAdmin` wrapper now verifies that the caller owns the session or
has a confirmed super-admin role before invoking the binding RPC. Missing
sessions and failed role lookups do not grant access.

Migration `20261021000000_restrict_admin_binding.sql` adds the same ownership
check **inside** the security-definer RPC. Direct database clients cannot be
secured by a web wrapper alone. The function locks the row before checking and
updating the binding, rejects calls without an authenticated user, and no longer
grants service-role execution without a user identity.

The migration is source only: **not applied or database-executed here**. Existing
databases remain vulnerable to direct RPC calls until this change is reviewed
and applied in an isolated environment, then deployed through an approved process.
The wrapper alone does not close that direct path.

### Reconnect

Reconnect now requires an existing active session with a consent timestamp.
Invited, consented-but-not-active, paused, declined and ended states cannot be
activated through reconnect.

The session write changes only `updated_at`, not state or mode. Conditional
filters recheck device, active state, mode and consent timestamp during the write.
A concurrent state change returns a conflict before follow-on writes. Invalid
code types are rejected rather than causing a `.trim()` runtime error.

A timestamp is not, by itself, a trustworthy enrollment grant: see the remaining
direct-session-write issue below.

## Checks performed

`node scripts/server-authorization-check.cjs`

20 checks passed against the actual TypeScript handlers using a mocked database:
state rejection, missing consent, unauthenticated requests, wrong device, missing
session, wrong code, invalid bodies/types, conditional update behavior, simulated
state-change conflict, owner binding, super-admin binding, unrelated users, role
lookup failures and missing binding targets.

All 163 imported TypeScript files parsed with zero syntax diagnostics.

This does not validate PostgreSQL execution, actual RLS behavior, transaction
races, semantic typing, browser flows, or Windows clients. No production
configuration, migration, devices or credentials were used.

## Remaining activation blockers found in the source trace

- Authenticated session owners can directly write session state, mode and
  `consent_at` under existing policies. Restrict these transitions at the
  database level; do not trust the timestamp check as a complete authorization boundary.
- The Agent still automatically accepts invitations without a recorded local
  informed grant. Installation/Meeting ID must not substitute for that grant.
- One-time unattended grant recording, separate view/control scopes and
  pre-existing-device handling remain incomplete.
- Peer clipboard/files/input bypass HTTP channel checks; enforce capability
  scope at the receiving endpoint and revoke it on teardown.
- File server functions and direct manifest policies need session-state and
  capability checks beyond session ownership.
- Existing frame/signal/input RLS requires state and scope review, including
  signed download lifetime and in-flight teardown behavior.
- Windows compilation and dependency-advisory issues remain unresolved.

The full app remains inactive. These are defensive changes, not certification
that remote access is ready to enable.
