## Goal

Before shipping new zips, do a line-by-line parity sweep across the three code bases that share the API surface (server routes, agent, admin) so nothing drifts after the `admin_client_id` / RLS / take-over changes. Then rebuild `ConnectLiveAgent.zip` and `ConnectLiveAdmin.zip`.

## 1. Route audit (read-only)

Cross-check every route in `src/shared/api-routes.ts` against its handler and every caller.

Server handlers to re-read:
- `src/routes/api/public/agent/enroll.ts`
- `src/routes/api/public/agent/hello.ts`
- `src/routes/api/public/agent/heartbeat.ts`
- `src/routes/api/public/agent/pair.ts` (must stay 410)
- `src/routes/api/public/agent/session.$sessionId.reconnect.ts`
- `src/routes/api/public/agent/session.$sessionId.consent.ts`
- `src/routes/api/public/agent/session.$sessionId.frame.ts`
- `src/routes/api/public/agent/session.$sessionId.inputs.ts`
- `src/routes/api/public/agent/session.$sessionId.signal.ts` (new `admin_client_id` + `terminated`)
- `src/routes/api/public/agent/session.$sessionId.cursor.ts`
- `src/routes/api/public/agent/power.$cmdId.ack.ts`
- `src/routes/api/public/auth/login.ts`
- `src/routes/api/public/webhooks/cdp.ts`
- `src/routes/api/public/cron/reconcile-orders.ts`
- `src/routes/api/public/stats/orders.ts`
- `src/routes/api/public/admin/bootstrap.ts`
- `src/routes/api/public/health.ts`

Callers to re-read for parity:
- Agent: `agent/src/ApiClient.cs`, `agent/src/WebRtcSession.cs`, `agent/src/PowerRelay.cs`, `agent/src/CursorPump.cs`, `agent/watcher/Program.cs`
- Admin: `admin/src/Api/ApiClient.cs`, `admin/src/Media/WebRtcClient.cs`, `admin/src/ViewModels/*`
- Web console: `src/routes/_authenticated/console.tsx`

Confirm for each route: HTTP method, path literal, request headers (`X-Device-Token` / `X-Device-Id` / `X-Deployment-Key` / Bearer), request body fields, response fields consumed by callers. Verify new `admin_client_id` and `terminated` propagate through: admin `CreateSessionAsync` → server `sessions` insert → agent poll filter → agent take-over post → admin `WebRtcClient` handler → `LiveSessionViewModel` banner.

Also verify the migration state: `sessions.admin_client_id`, `session_signals.admin_client_id`, `terminated` kind allowed, indexes `(technician_id,state)` and `(session_id, admin_client_id, id)`, and RLS on `session_frames`/`session_inputs`/`session_signals`/`session_cursors` gating on owning technician OR super_admin.

Run `bun run scripts/verify-agent-routes.ts` and `bun run scripts/verify-payment-routes.ts` against the live deployment. All must pass (12/12 and 5/5).

## 2. Fix anything the audit flags

Only patch drift found in step 1. Likely candidates if any surface:
- missing `admin_client_id` on a signal POST path
- server route not echoing `admin_client_id` in poll response
- watcher/agent URL literal not matching `API_ROUTES`
- console.tsx still assuming pre-RLS visibility of another admin's frames

If nothing drifts, skip straight to step 3.

## 3. Rebuild both zips

- `agent/build.ps1` → `dist/ConnectLiveAgent.zip` (agent + watcher + install scripts + README).
- Equivalent packaging for admin → `admin/dist/ConnectLiveAdmin.zip` (WPF single-file publish + install notes).

Both are win-x64 self-contained single-file publishes. Provide download links / paths at the end of the turn, one after the other as requested.

## 4. Out of scope

- No new features, no schema changes beyond what's already in `.lovable/plan.md`.
- No MSI resign — user handles code-signing.
- No changes to payments, orders, or agent enrolment flow.

## Technical notes

- Zip builds require Windows + .NET 8 SDK; in this sandbox we produce the source tree + build scripts and rely on `agent/build.ps1` / `admin` publish command. If the sandbox cannot run `dotnet publish` for win-x64 WPF, I will surface that clearly instead of shipping a broken artifact.
- Route parity is enforced by re-reading, not by regex — the registry in `src/shared/api-routes.ts` is the source of truth; every C# literal must match it exactly.
