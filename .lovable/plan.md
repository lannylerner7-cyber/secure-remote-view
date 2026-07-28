# Signal Persistence & Transport Hardening

Goal: make admin↔agent signaling survive network blips, page refreshes, admin/agent restarts, and peer take-overs — without ever dropping an ICE candidate or leaving a stale admin bound to a session.

## 1. Retry / queue failed signals (both sides)

Web (`src/lib/webrtc-live.ts`) and C# admin (`admin/src/Api/ApiClient.cs`):
- Wrap every signal insert in a per-session in-memory FIFO queue with monotonic `attempt_id`.
- Exponential backoff (250ms → 4s, cap 6 retries) on transient failures (network, 5xx, 409 `admin_client_id_mismatch` during a take-over race).
- Hard-drop on 400/401/404/413 with a surfaced console warning + UI toast (web) / status banner (C#).
- Agent (`agent/src/ApiClient.cs`) already has HTTP retry; add the same FIFO ordering so an ICE candidate cannot be re-ordered ahead of the answer it depends on.

## 2. Persist signals across reconnects

Web:
- Move `web_client_id` from ad-hoc localStorage read to a single `getWebClientId()` helper.
- Per-session cursor: persist `lastSeenSignal:{sessionId}` in `sessionStorage` so a page refresh resumes at the right signal id instead of replaying `answer` and re-negotiating.
- On startup, if a `sessions` row for this device is still `active` and its `admin_client_id === web_client_id`, resume signaling (skip the offer, wait for `ice`) instead of creating a fresh offer.

C# admin:
- `ClientIdStore` already persists the id. Add `SignalCursorStore` (JSON file under `%LOCALAPPDATA%\ConnectLive\Admin\cursors.json`) keyed by `sessionId → maxSignalId`, pruned when a session ends.

Agent (`agent/src/WebRtcSession.cs`):
- Already tracks `_lastSignalId` in memory. Persist to DPAPI-protected session store so watcher→agent wake-ups continue polling from the right offset.

## 3. Switch transport: Realtime broadcast + authenticated server fn

Two-tier transport with automatic downgrade:

- **Primary:** Supabase Realtime `broadcast` channel `sig:{sessionId}` for low-latency SDP/ICE. Both peers subscribe; each message carries `{ from_side, admin_client_id, kind, payload, attempt_id }`. Not persisted — used only for live delivery.
- **Durable mirror:** every broadcast is also written to `session_signals` (existing table) via the queue in §1. That's the resume/replay log for §2 and the audit trail.
- **New authenticated server fn** `postAdminSignal` (`src/lib/webrtc-signal.functions.ts`) using `requireSupabaseAuth`, so the web admin never touches `session_signals` directly. The server fn:
  - verifies the caller owns the session (technician_id = auth.uid() OR has_role super_admin),
  - re-checks the `admin_client_id` binding server-side,
  - writes to `session_signals`,
  - broadcasts on `sig:{sessionId}`.
- Web console stops calling `supabase.from("session_signals").insert(...)`. Broadcast subscribe stays client-side (read-only path).
- C# admin keeps its direct REST insert (already binding-enforced by RLS) but adds a broadcast publish via the Realtime REST endpoint for parity.

## 4. Heartbeat the admin binding

New column `sessions.admin_bound_at timestamptz` + a `bind_admin(session_id, client_id)` SECURITY DEFINER RPC that:
- refuses if the session is not `active`,
- sets `admin_client_id = client_id, admin_bound_at = now()` when current binding is NULL, matches, or is older than 45s (auto-release stale).

Web (every 15s while a live view is open) and C# admin (`SessionManager` timer) call `bind_admin`. If the RPC returns "superseded" (another admin took over), the client transitions to the existing `superseded` state and closes cleanly.

`prune_session_ephemera()` also clears `admin_client_id` where `admin_bound_at < now() - interval '90 seconds'` on `active` sessions, so a hard-crashed admin releases the peer without waiting for session end.

## 5. Migration + verification

Single migration:
- `ALTER TABLE public.sessions ADD COLUMN admin_bound_at timestamptz;`
- `CREATE OR REPLACE FUNCTION public.bind_admin(...)` + grants to `authenticated`.
- Extend `prune_session_ephemera` with the 90s auto-release.
- Add `session_signals(session_id, attempt_id)` unique index to make the retry queue idempotent (agent + admin both stamp `attempt_id`; duplicate inserts become no-ops).
- Extend `scripts/verify-agent-routes.ts` with: retry-on-409, resume-after-refresh, stale-admin auto-release, and cross-peer broadcast isolation cases.

## Deliverables

- Updated `src/lib/webrtc-live.ts`, new `src/lib/webrtc-signal.functions.ts`, updated `src/routes/_authenticated/console.tsx` (uses the server fn).
- Updated `admin/src/Api/ApiClient.cs`, new `admin/src/Api/SignalCursorStore.cs`, updated `admin/src/Media/WebRtcClient.cs`.
- Updated `agent/src/WebRtcSession.cs`, `agent/src/ApiClient.cs`, persisted `_lastSignalId`.
- One Supabase migration (schema + RPC + prune extension + unique index).
- Extended verifier script.
- Rebuilt `ConnectLive-RemoteAgent.zip` and `ConnectLive-AdminConsole.zip`.

## Out of scope

- No change to the underlying WebRTC codec pinning or DXGI pipeline.
- No new UI beyond the take-over/failed banners already present.
