# Import and defensive verification delivery

## Scope and result

The imported source, the two extracted builder archives, the isolated public
preview, and the defensive access-policy implementation are delivered.
This is **not** a production activation, a signed Windows release, or proof of
end-to-end operation. The task explicitly permits unavailable environments to be
recorded as blocked and excludes secrets, production delivery and Android work.

## Implementation

- Existing architecture preserved: TanStack Start/Supabase and .NET Windows clients.
- Explicit foreground attended/unattended authorization, independent scopes,
  protected local grant bound to device/origin, and matching server record.
- No legacy timestamp/enrollment-only grant inference; unattended sessions stay
  prompt-free within an explicitly recorded matching grant.
- Grant-bound consent and checks on server, database-policy source and Agent
  channel boundaries. Local withdrawal takes effect before network operations.
- End/pause/revocation invalidate old session channels and input; authorized
  presence is distinct from screen capture.
- Native Admin recording requires current server authority with a five-second
  local lease and per-frame checks. Renewal cannot revive an expired recording.
- Browser recording also requires a current recording grant: denied grants do
  not construct a recorder, revocation/expiry stops recording and discards its
  unsaved chunks, and saving revalidates authority. UI reflects automatic stop.
- Initial offline enrollment retries asynchronously and stops on withdrawal or
  shutdown; retries never grant authorization or bypass the foreground agreement.
- Browser/native file exchange uses authenticated, scoped per-request proxies
  instead of reusable signed URLs. Existing encrypted ZIP behavior is preserved
  in source, not claimed runtime-tested.
- Both Windows projects use patched SIPSorcery. Agent compilation no longer
  includes the separate Watch project's generated sources.

## Evidence

| Check | Result and limitation |
| --- | --- |
| Windows Agent cross-build | Passed, zero errors; 3 existing compiler/DPI warnings. Not executed on Windows. |
| Windows Admin cross-build | Passed, zero errors; 6 existing nullable/DPI warnings. Not executed on Windows. |
| Actual-source portable Agent grant/startup runner | 54 assertions passed |
| Browser recording-authority runner | 16 assertions passed |
| Actual browser WebRTC wrapper | 13 recording assertions passed with mocked browser/transport APIs; not a real browser |
| Local withdrawal/input guard runner | 14 checks passed |
| Server ownership/consent regression runner | 44 checks passed, mocked database/RPC |
| Recorded authorization runner | 18 checks passed, mocked database/RPC |
| File proxy runner | 25 checks passed, mocked DB/storage/JWT/ZIP |
| Payment identity runner | 15 checks passed; payment engine remains unfinished |
| Newsletter configuration runner | Passed synthetic-key configuration cases |
| Imported TS/TSX parse | 171 files, zero syntax diagnostics; not full semantic compilation |
| Running isolated preview | Typecheck passed; no live auth, payment or remote endpoints |

No test in this table substitutes for PostgreSQL RLS/locking, actual storage,
Windows UI/DPAPI/native APIs, or a connected end-to-end journey.

## Lifecycle coverage

| State | Isolated evidence | Runtime status |
| --- | --- | --- |
| Missing/legacy/revoked grant | Server and portable Agent deny checks | Blocked: isolated DB + Windows needed |
| Correct/wrong device, origin, grant or scope | Portable matching and server handler checks | Blocked |
| View-only/control | Receiver and server scope checks | Native input/capture blocked |
| Clipboard/files/recording | Agent scopes, proxy checks; Admin recording compiles | Native/real storage/recording blocked |
| Consent acceptance/race | Atomic RPC contract mocked; stale invite denied | Actual transaction locking blocked |
| Pause/end/reconnect | Invalidation and server transition checks | Transport teardown/realtime blocked |
| Disable/revoke/restart | Marker and grant checks | Windows restart/watchdog/uninstall blocked |

## Remaining delivery gates

1. Apply and exercise migrations in an isolated Supabase-compatible database.
   Validate every historical policy/trigger, locking, realtime and quota race.
2. Connect isolated auth/storage and verify browser/native requests, actual ZIP
   encryption, body/time/memory limits and orphan cleanup. Previously issued
   signed URLs and bytes already delivered cannot be clawed back.
3. On Windows, exercise enrollment UI, DPAPI, attended/unattended, local disable,
   pause/end/revocation, all transports and reinstall/watchdog behavior.
4. Only after those checks: finish connected application configuration and
   separately authorized production delivery/signing. No release ZIP is supplied
   from these cross-compilation checks.

Power dispatch remains denied: this grant version does not authorize power
management. It needs an explicit capability and lifecycle design, not an implicit
expansion of screen-control permission.

## Navigation

- `docs/request-surface-inventory.md`: declarations and static caller fragments;
  not a claim that dynamic routes have all run.
- `docs/agent-grant-implementation.md`, `docs/server-grant-implementation.md`:
  detailed implementation boundaries.
- `docs/payment-quote-progress.md`: separate, unfinished payment replacement.
- `docs/client-archive-review.md`: source/build ZIPs versus compiled releases.
- `docs/service-configuration.md`: configuration inventory.
