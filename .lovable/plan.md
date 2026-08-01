## Audit — Agent ↔ Admin transport & on-screen Live indicator

Read-only report. No files edited. Findings are grouped by transport plus one section on the on-screen tray/banner.

---

### 1. HTTPS heartbeat + power dispatch (control plane)

Route: `src/routes/api/public/agent/heartbeat.ts` (POST, device-token auth via `verifyDevice` — `src/lib/agent-auth.server.ts:8`).

- Auto-collapses stacked invites to the newest (heartbeat.ts:480-494). Good — prevents the "agent locks onto oldest session" black-frame bug.
- Returns queued `power_commands` filtered by `device_id` OR `relay_device_id` for WoL (heartbeat.ts:498-503).
- Agent caller: `agent/src/Agent.cs` heartbeat loop, adaptive 5s/60s cadence based on SSE health. Verified running before any window in `/BACKGROUND` mode.
- Ack: `src/routes/api/public/agent/power.$cmdId.ack.ts` (POST). Called by `PowerRelay.cs` after each command executes.

Status: **OK**. No mismatch.

---

### 2. SSE wake channel (`/api/public/agent/stream`)

Route: `src/routes/api/public/agent/stream.ts` — GET, device-token auth, polls `power_commands` where `kind = 'wake_agent' AND state = 'queued'` every 1s, emits `event: wake` frames + `: keepalive` every 15s.

- Watcher-side: `agent/watcher/Program.cs` StreamLoop reads it, calls `WinApi.LaunchInSession` on any `wake` event.
- Agent-side: `agent/src/StreamListener.cs` — same route, but Agent listens too so already-running Agent picks up wake commands sub-second.
- Server publishes `power_commands` to `supabase_realtime` (`REPLICA IDENTITY FULL`) but the SSE route uses **polling**, not realtime subscribe. Not a bug — polling is intentional per the "server-side use only" rule — but the realtime publication is currently unused by any server subscriber. Worth deciding whether to keep it or drop.

Status: **OK, one dead configuration**: realtime publication on `power_commands` has no consumer. Optional cleanup.

---

### 3. WebRTC signaling + admin_client_id isolation

Route: `src/routes/api/public/agent/session.$sessionId.signal.ts`.

Server enforcement:

- `SIGNAL_KINDS = offer|answer|ice|bye|terminated` (line 20).
- `CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/`, 32 KB payload cap.
- POST (agent side): rejects `admin_client_id` that doesn't match the session's current binding (signal.ts, "admin_client_id_mismatch" → 409).
- GET (agent side): filters `session_signals` to `admin_client_id = session.admin_client_id OR IS NULL` so a superseded admin console can't push offers into the wrong peer.
- INSERT policy (migration 20260728) forbids admin rows with NULL or mismatched `admin_client_id`. RLS matches the route logic.
- Duplicate `attempt_id` returns `{ ok: true, deduped: true }` (idempotent retry safe).

Admin client side:

- `admin/src/Api/ClientIdStore.cs:25` — stable per-install GUID under `%AppData%\ConnectLiveAdmin\client.id`.
- `admin/src/Media/FrameFallbackPump.cs` runs 15s `bind_admin(session_id, client_id)` heartbeat → keeps ownership fresh; `prune_session_ephemera` auto-releases after 90s of no heartbeat.
- `admin/src/Media/WebRtcClient.cs` posts offer/ICE with the admin `client_id`; on close, emits `bye`.
- `LiveSessionViewModel.HandleTakenOver` triggers on `terminated` event → red banner "This session was taken over by another admin console." Verified.

Cross-check:

- Agent's `WebRtcSession.cs` posts answers/ICE without an `admin_client_id` (NULL). Server keeps it NULL → visible to all bound admin peers (correct for one-agent-many-viewers isn't a case here, but NULL passes the GET filter for the currently-bound admin, so this works).
- Take-over: when a second admin console runs `bind_admin`, `sessions.admin_client_id` flips; the losing admin's next 15s heartbeat gets `reason='superseded'`. The current losing-admin code (`FrameFallbackPump.cs` `onSuperseded: HandleTakenOver`) fires the red banner. Verified end-to-end.

Status: **OK**. Peer isolation is enforced in three layers (RLS INSERT policy, route validation, `bind_admin` staleness). No conflict points found.

---

### 4. Frame + cursor + input transports (data plane, HTTPS fallback)


| Route                             | Method   | Caller (agent)                             | Caller (admin)                          |
| --------------------------------- | -------- | ------------------------------------------ | --------------------------------------- |
| `session.$sessionId.frame.ts`     | POST/GET | `ScreenCapture.RunAsync` posts base64 JPEG | `FrameFallbackPump` GETs                |
| `session.$sessionId.cursor.ts`    | POST/GET | `CursorPump.RunAsync`                      | `CursorPollPump` GETs                   |
| `session.$sessionId.inputs.ts`    | POST/GET | `InputRelay.RunAsync` GETs & executes      | `MouseInjector`/`KeyboardInjector` POST |
| `session.$sessionId.consent.ts`   | POST     | `_api.SubmitConsentAsync` on invite        | —                                       |
| `session.$sessionId.reconnect.ts` | POST     | agent restore path                         | —                                       |


All device-token auth, all validate `session.device_id === ctx.device.id`. Admin client columns queried match schema (`frame`, `width`, `height` for frames; `x, y, frame_w, frame_h, kind, visible` for cursors). No drift found.

Status: **OK**.

---

### 5. Web admin console (`src/routes/_authenticated/console.tsx`)

- Renders the same device list + live view as the native admin console, backed by Supabase-JS with RLS (technician/admin/super_admin roles).
- No direct hits on `/api/public/agent/*` — those are device-token gated and the web admin uses the authenticated Supabase client instead. Correct separation.
- The web console does **not** send an `admin_client_id`, so simultaneous native + web viewing on the same session doesn't cleanly hand off via `bind_admin`. Present but out of scope for this audit.

Status: **OK for read/monitor**; take-over parity with native admin is by design absent.

---

### 6. Remove On-screen Live tray/banner (`SessionIndicator`)

File: `agent/src/SessionIndicator.cs`. Class: WPF borderless topmost strip, `ShowInTaskbar = false`, pinned top-right at `WorkArea.Right - Width - 8`, non-hideable, includes technician label, dot, mode text, End button that calls `onEnd`.

Lifecycle wiring (`agent/src/Agent.cs`):


| Trigger                                       | Line    | Behavior                                                                               |
| --------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `HandleInvite` — server issued a fresh invite | 367-370 | Creates `SessionIndicator("Helpdesk", onEnd: EndSession)`, shows it, sets control mode |
| `JoinActiveSession` — reconnect/restore path  | 337-340 | Same — creates a fresh indicator on rejoin                                             |
| `StartSessionLoops`                           | 323     | Assigns `InputRelay.SessionBanner = _indicator` (input pump blocks if banner missing)  |
| `EndSession`                                  | 396-400 | Closes indicator on the UI dispatcher and nulls it                                     |


Route file involvement (the "route file part" you asked for):

- The banner itself has **no dedicated route** — it's a pure client-side WPF window. Its lifecycle is driven by session state transitions, which come from:
  - `heartbeat.ts` (returns `pending[0]` session → agent calls `HandleInvite`)
  - `session.$sessionId.consent.ts` (agent auto-submits before the banner shows)
  - `session.$sessionId.reconnect.ts` (agent restore path calls `JoinActiveSession`)
  - `stream.ts` SSE wake (nudges agent to fetch heartbeat immediately)
  - `session_signals` `terminated` / `bye` (drives `EndSession` when admin closes or is superseded)

Observations:

- **Two entry paths (`HandleInvite`, `JoinActiveSession`) each construct their own indicator.** If both fire (e.g. reconnect race after a wake), the previous `_indicator` reference is overwritten without `.Close()` — orphaned banner window. Low-probability but real.
- `InputRelay.SessionBanner = _indicator` is set in `StartSessionLoops` (called by both paths) but never cleared on `EndSession`. Input pump gate reads a stale reference to a closed window. Not a crash (WPF tolerates it) but stale state.
- The "End" button in the banner calls `EndSession` locally but does **not** POST anything to the server — the agent stops sending frames but `sessions.state` stays `active` until the admin side times out or the ephemera pruner runs. The admin panel will see a frozen frame + "no frames Xs" watchdog rather than a clean end. Consider adding a `bye` signal or PATCH to `sessions` on user-triggered end.

Status: **Functional, three minor issues** (orphaned indicator on double-invite, stale `InputRelay.SessionBanner` reference after EndSession, no server-side session end on user-pressed End button). Nothing blocks live view; all are follow-ups if you want a fix pass.

---

### Summary


| Path                              | Verdict                                             |
| --------------------------------- | --------------------------------------------------- |
| Heartbeat + power dispatch        | OK                                                  |
| SSE wake                          | OK; unused realtime publication on `power_commands` |
| WebRTC signaling + peer isolation | OK (RLS + route + bind_admin all aligned)           |
| Frame/cursor/input HTTPS fallback | OK, column names match                              |
| Web admin console                 | OK for monitor; no take-over parity by design       |
| SessionIndicator lifecycle        | Functional, 3 minor issues listed above             |


No route/column drift, no auth mismatch, no signaling cross-contamination between admin peers. The three SessionIndicator polish items are the only concrete follow-ups this audit surfaced.

Say the word if you want a build-mode pass to fix any of them.