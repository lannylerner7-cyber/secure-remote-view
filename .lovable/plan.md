## Goal

Audit every route, query and signaling path across DB, TSS server routes, C# Agent, C# Admin, and the Web Console — then close the peer-admin signal-interception gaps so two admin machines on the same technician account cannot poison each other's WebRTC/input stream.

## Findings (verified against the repo + live DB policies)

### A. Signal interception — critical

1. `**session_signals` INSERT policy** (`from_side='admin' AND session owner`) does **not enforce `admin_client_id**`. A peer admin box can post with `admin_client_id = null` or spoof another box's id, and the agent's routing filter (`admin_client_id.eq.ours OR is.null`) treats the null case as a broadcast → both admins receive the answer/ICE for a session that only one of them is driving.
2. `**src/lib/webrtc-live.ts**` (web console) inserts admin offers/ICE **without any `admin_client_id**`, and its realtime subscription filter is only `session_id=eq.<id>` + `from_side==='agent'`. Two web-console tabs on the same session cross-wire immediately, and there is no `terminated` handler.
3. **Agent → admin GET signal endpoint** returns every admin-originated row regardless of `admin_client_id`; the agent has to filter client-side. Fine, but noisy — the server should scope by the caller's currently-bound admin peer when one is bound.
4. `**session_inputs` / `session_cursors` / `session_frames**` are owner-scoped by `technician_id` only. When two admin boxes share the same technician account, both write/read the same `session_inputs` rows — mouse/keystrokes from Box B leak into the session Box A is driving. Needs `admin_client_id` scoping too (or a `sessions.admin_client_id` binding read).

### B. Route / query correctness

5. Web console still calls `supabase.from('session_signals').insert(...)` directly instead of going through the authenticated `/api/public/agent/session/:id/signal` (agent-only) or a new authenticated server fn. Because the browser goes direct-to-Data-API under RLS, no server-side `admin_client_id` stamping happens.
6. `**session.$sessionId.signal.ts` POST** does not validate `admin_client_id` shape (UUID / length cap), does not size-limit `payload` (an agent bug could enqueue MBs into Postgres), and does not verify the row's `admin_client_id` matches the `sessions.admin_client_id` binding — so a compromised agent could stamp another admin's id and hijack routing.
7. `**session.$sessionId.frame.ts` / `cursor.ts` / `inputs.ts**` are not shown here but per the earlier audit they don't verify `sessions.state='active'` on every write; `signal.ts` does — bring the others in line.
8. `**heartbeat.ts**` returns "newest session + auto-end duplicates". Verify it also clears `admin_client_id` on the ended row so a stale binding can't outlive its session.
9. `**login_attempts**` has RLS enabled but 0 policies and denies everything — confirm the login route uses the service-role admin client (it does via `adminClient()`), and that no client code queries it.
10. `**verify-agent-routes.ts**` covers the 401 gate but not: (a) admin_client_id enforcement, (b) that legacy web direct-insert paths are removed, (c) the `terminated` handshake round-trip.

### C. Boundary / sanitation sweep

11. Every `/api/public/agent/*` handler: add explicit Zod validation (kind, payload byte-cap, uuid check on `admin_client_id`), consistent JSON error shape, and never echo `payload` back on error.
12. Every C# `PushSignalAsync` / `PatchSessionAsync` call: stamp `App.ClientId`; never allow null on the admin side.
13. Every C# poller: drop rows whose `admin_client_id` is set AND != `App.ClientId` AND != null-bound; ignore `bye` from other client ids.

## Fix plan (order matters — DB before code)

### Phase 1 — Database (single migration)

- Add `sessions.admin_client_id text` (already present) NOT-NULL only when `state='active'`; enforce via trigger.
- Rewrite `session_signals` INSERT policy (admin side):
`from_side='admin' AND admin_client_id IS NOT NULL AND EXISTS(session where technician_id=auth.uid() AND (admin_client_id = new.admin_client_id OR admin_client_id IS NULL))`
→ forbids null on admin writes and forbids spoofing a bound peer's id.
- Add a trigger on `sessions` that on UPDATE clears `admin_client_id` when `state` transitions to `ended`.
- Scope `session_inputs` INSERT/SELECT and `session_cursors`/`session_frames` SELECT with:
`technician owner AND (sessions.admin_client_id IS NULL OR sessions.admin_client_id = current_setting('request.headers')::json->>'x-admin-client-id')` — implemented via a `has_client_binding(session_id, client_id)` SECURITY DEFINER helper that reads the header PostgREST forwards. Fallback: keep current owner scope + do the filter at the server-fn layer for web console.
- Add explicit `GRANT SELECT ON public.session_signals TO authenticated` audit (already granted — confirm, don't re-issue if present).

### Phase 2 — Server routes (`src/routes/api/public/agent/session.$sessionId.*.ts`)

- `signal.ts`:
  - Zod schema: `kind ∈ enum`, `payload ≤ 32 KB JSON`, `admin_client_id` must be uuid-ish (length ≤ 64, `[a-zA-Z0-9-]`).
  - On agent POST, verify `body.admin_client_id`, when present, equals the current `sessions.admin_client_id` binding; else 409.
  - GET filters rows by the caller's bound admin_client_id when the session has one.
- `frame.ts`, `cursor.ts`, `inputs.ts`: reject when `sessions.state !== 'active'`; cap `frame`/`payload` bytes.
- `heartbeat.ts`: when auto-ending stale duplicates, set `admin_client_id = NULL` in the same UPDATE.
- All handlers: uniform JSON error shape `{error, code}`; no payload echo on error.

### Phase 3 — Web console (`src/lib/webrtc-live.ts` + `src/routes/_authenticated/console.tsx`)

- Introduce a per-browser `web_client_id` in `localStorage` (uuid v4).
- Route ALL admin signal writes through a NEW authenticated server fn `pushAdminSignal({sessionId, kind, payload})` that stamps `admin_client_id = <web_client_id>` server-side after `requireSupabaseAuth`. Remove the direct `supabase.from('session_signals').insert(...)`.
- Realtime subscription: filter `admin_client_id=eq.<web_client_id> OR admin_client_id IS NULL` client-side; drop rows for other admin ids.
- Add `terminated` handler that closes the RTCPeerConnection and shows a "another admin took over" banner (parity with C# Admin).
- Session take-over: before opening a new PC, `PATCH /sessions/:id` to stamp `admin_client_id = <web_client_id>` (same pattern as `admin/src/Api/ApiClient.cs`).

### Phase 4 — C# Admin (`admin/src/Api/ApiClient.cs`, `Media/WebRtcClient.cs`)

- `PushSignalAsync`: assert `App.ClientId` non-empty; refuse to send otherwise.
- `PollAgentSignalsAsync`: drop items where `AdminClientId != null && AdminClientId != App.ClientId`.
- `WebRtcClient.PollAgentSignals`: on `terminated` targeted at `App.ClientId`, close and surface banner (already partially implemented — verify id match).

### Phase 5 — C# Agent (`agent/src/WebRtcSession.cs`, `agent/src/ApiClient.cs`)

- On receiving an admin offer, remember `boundAdminClientId`; every subsequent agent-side push MUST stamp that id.
- On receiving a NEW offer with a different `admin_client_id`, post `terminated` targeted at the previous id first, then rebind.
- Verify `InputRelay` / `CursorPump` consume only inputs from `session_inputs` rows whose owning session's `admin_client_id` equals the bound id (server-fn already filters — add belt-and-braces client filter).

### Phase 6 — Verification

- Extend `scripts/verify-agent-routes.ts`:
  - POST `/signal` with missing `admin_client_id` from an authorized agent → expect 400.
  - POST `/signal` with mismatched `admin_client_id` → expect 409.
  - GET `/signal?since=0` returns only rows for the caller's bound admin (mocked in a Bun test).
- Add a new `scripts/verify-web-signal-path.ts` that hits the new `pushAdminSignal` server fn without auth (expect 401) and with a bogus session (expect 404).
- Run `supabase--linter` after the migration; fix any new advisories.
- Manual smoke: two web-console tabs + one C# admin on the same technician account → confirm only the take-over machine drives the session; others see the banner.

## Non-goals

- No new UI features. No renames. No changes to payment/order surfaces. No touching `_authenticated/route.tsx` auth gate.

## Rollout

Ship Phase 1 + 2 first (server-side lockdown is safe — old clients keep working, they just get 400s on malformed calls). Then Phase 3–5 clients in the same turn. Repackage both zips at the end and re-run `verify-agent-routes.ts`.

- The stricter INSERT policy will break any older Admin/Agent build that omits `admin_client_id`. Mitigation: the current shipping builds already stamp it; older builds (pre-take-over) are not in the field per prior audits.
- Header-based RLS via `has_client_binding` only works when PostgREST forwards `X-Admin-Client-Id`. If Lovable Cloud strips it, fall back to server-fn scoping only (Phase 3 covers web; agent already filters). Verify with a probe request as the first step of Phase 1.

&nbsp;

&nbsp;

## 3 Critical Details to Watch During Execution

To ensure this deployment goes off without a single hitch, keep these three edge cases in mind as you execute:

### 1. Database Indexing for Polling Performance

With the new admin_client_id filters on session_signals, high-frequency pollers (like the C# Admin or Web Console polling every few hundred milliseconds) can cause high DB CPU usage if indexes aren't aligned.

 * **Fix in Phase 1:** Ensure your migration explicitly creates a composite index:

   ```sql

   CREATE INDEX IF NOT EXISTS idx_session_signals_routing 

   ON public.session_signals (session_id, admin_client_id, created_at);

   

   ```

### 2. PostgREST Custom Header Forwarding Risk

In Phase 1, using current_setting('request.headers')::json->>'x-admin-client-id' inside Postgres RLS functions requires PostgREST to forward that custom header. Some proxy layers or cloud gateways strip non-standard headers before they reach Supabase.

 * **Mitigation:** Rely on **Phase 2 & Phase 3 (Server API validation)** as your primary defense layer. Use RLS as the safety net, but enforce admin_client_id matching strictly inside the API endpoints before the query even hits the database.

### 3. Takeover Handshake Order in C# Agent

In Phase 5, when a new Admin sends an offer to an active session, the Agent must send the terminated frame to the *old* admin_client_id **before** updating its internal boundAdminClientId state. If you update the local variable first, the termination frame will accidentally be addressed to the *new* admin instead of the disconnected one.

## Recommended Execution Order

The rollout plan is staged correctly: **DB Migration (Phase 1) \rightarrow Server API Lockdown (Phase 2) \rightarrow Client Implementations (Phases 3–5) \rightarrow Automated Verification (Phase 6)**.

Because current C# shipping builds already stamp admin_client_id, applying Phase 1 and Phase 2 first will immediately secure the backend without breaking active development builds.

Would you like to start by generating the complete **Phase 1 SQL Migration Script** (including the triggers, RLS policies, and composite indexes), or would you prefer to start with the **Phase 2 Zod-validated Server API routes**?

&nbsp;