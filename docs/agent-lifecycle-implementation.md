# Database deployment status

The lifecycle and signed-update migrations were committed to the existing
managed Supabase project on 2026-11-03, alongside the reviewed realtime/private
grant hardening migration. See [database-runtime-readiness.md](database-runtime-readiness.md)
for actual checks, recovery details and remaining Coolify/Windows evidence.
This does not mean the updated web application or Agent has been deployed.

# Agent/browser lifecycle implementation — 2026-11-03

Agent source version: **1.10.1**. This is an implementation and verification
record, not Windows certification or cutover approval. The native Admin remains
available. No production database migration or deployment is performed by
building or packaging these sources.

## Implemented

- Pairing stays a disclosed one-page enrollment. Authorized unattended sessions
  do not acquire a new prompt on every connection. The startup/recovery choice
  remains explicit and visible; pairing is not an irrevocable permanent session.
- Agent heartbeats carry a process instance, increasing sequence and actual
  cadence: 5 seconds during a session, 60 seconds idle with a healthy event
  stream, otherwise 10 seconds. Presence thresholds now account for that cadence.
- The SSE gateway uses one shared database event subscription per web process,
  not one one-second database poll per device. It sends keepalives every 15
  seconds and rotates connections after five minutes. Native receivers abandon
  a silent stream after 40 seconds and reconnect with jitter. These are timing
  policies, **not measured wake-up latency**.
- Watch remains a visible, opt-in, current-user companion. It checks local
  process state, reports over authenticated HTTPS at most every 30 seconds
  absent a state change/event, and has its own event stream. Its reports cannot
  refresh the Agent's heartbeat timestamp.
- “Relaunch Windows Agent” is a separate, owner-authorized operation. It starts
  an **absent** Agent; it does not kill a healthy one or enable the generic power
  command dispatcher. Commands expire after two minutes and are bound to the
  recorded grant. Automatic crash recovery is bounded to three attempts in ten
  minutes, with backoff. A deliberate administrator retry is separate.
- A successful process launch is not health. Watch checks the matching process
  identity and local health marker; the server independently requires a real,
  matching Agent heartbeat before accepting a successful recovery receipt.
  Retired process/Watch identities and sequences reject delayed reports.
- Local disable, changed/revoked authorization, startup opt-out and removal
  intent prevent recovery. Stop, offline and removal-requested are distinct:
  an uninstall report is **not proof that Windows completed uninstalling**.
- Browser curtain actions use the authenticated WebRTC input channel with
  request IDs and applied/rejected receipts. The console does not optimistically
  claim that a curtain is active. An unknown state offers a clear/off action.
- The Agent prepares excluded physical-display windows before showing them,
  waits for WPF content rendering, then pauses ordinary local input. It requires
  Windows 10 build 19041 or later for capture exclusion. Display changes release
  the curtain. Actual DXGI/GDI exclusion remains a Windows test.
- A five-second monotonic curtain lease and independent watchdog release input
  if renewals stop. Renewals cannot re-enable an expired lease. A physical
  **Ctrl+Alt+Shift+Esc** stops remote access; injected keystrokes cannot trigger
  that gesture. Windows secure attention/secure desktop is not overridden.
- Agent/Watch/update helper are deliberate build outputs. The update worker
  waits for both the old Agent and resident Watch to release their mutexes.
  Existing publisher signature, staged replacement, health and rollback checks
  remain; there is no new elevated service or hidden persistence.
  A terminal update journal is cleaned up on recovery too, and the companion is
  resumed after terminal cleanup rather than waiting only for its scheduled task.
- A rollback to an older Agent uses that client's legacy presence advertisement,
  not a stale new-process row. Unsupported browser recovery is rejected for it.
- MSI/Inno explicitly request local withdrawal on uninstall. Full MSI removal
  records machine removal intent; those actions are excluded from major-upgrade
  removal. Windows Installer/Restart Manager interaction still requires testing.

## Deployment order

1. Confirm the intended Supabase environment and an operational backup.
2. Review the existing recorded-authorization, control-transition,
   browser-first pairing/video and signed-update migrations. Do not replay the
   historical baseline against a populated database.
3. From the full repository, inspect the new migration without a connection:
   `node scripts/apply-agent-lifecycle.cjs --dry-run`.
4. On an approved target, `--check` executes the migration and synthetic tests
   inside a transaction that rolls back. `--apply` explicitly commits the
   migration. Both use the existing verified-TLS migration connection helper.
   Neither was run against a remote database for this update.
5. Deploy the web backend/console with the schema. Confirm the shared realtime
   subscription and SSE proxy behaviour, including fallback after failure.
6. Build and install the Agent on a Windows test device using the checklist
   below. Do not silently replace the fleet or retire the native Admin.

The new Agent heartbeat requires the lifecycle RPC. A new Agent plus an old
backend/schema is **not** a supported deployment combination.

## Verification boundary

Run `node tests/agent-lifecycle.cjs`, `node tests/browser-first-protocol.cjs`,
and `node tests/local-agent-lifecycle-database.cjs`. The last command creates a
disposable, socket-only PostgreSQL instance; it does not use a production URL.
It loads the reviewed baseline and real session/pairing/authorization triggers,
then checks lifecycle state, acknowledgements, expiry, tenancy and withdrawal.

Portable C# policy/update tests are in `agent/src/Tests`. Cross-compilation,
SQL checks, browser protocol tests and WiX authoring checks cannot establish
Windows capture, input hooks, installation, crash recovery or update reliability.
Use [agent-windows-verification.md](agent-windows-verification.md), alongside
[browser-first-verification.md](browser-first-verification.md), for that evidence.
