## Route parity audit — findings

**Backend endpoints (verified):**
- Agent surface: `enroll · hello · heartbeat · pair(410) · power/$cmdId/ack · session/$id/{consent,cursor,frame,inputs,reconnect,signal}`
- Non-agent public: `auth/login · admin/bootstrap · webhooks/cdp · cron/reconcile-orders · stats/orders · health`

**Agent client (`agent/src/ApiClient.cs`)** — covers every agent route. One
cleanup nit: `ReconnectSessionAsync` still shells out via a "PairResult"
record shape (naming leftover from the retired `/pair` endpoint). It works
but names lie; rename to `ReconnectResult` for read clarity.

**Admin client (`admin/src/Api/ApiClient.cs`)** — direct PostgREST reads/writes
plus `bind_admin` RPC. Four real parity gaps vs. web console + agent:

1. **`bind_admin` heartbeat is WebRTC-only.** When negotiation fails and the
   admin falls back to JPEG polling, no session binding is claimed — a second
   admin box can silently steal the same session with no eviction. Needs a
   heartbeat loop mirrored inside `FrameFallbackPump`.
2. **No explicit "bye" on window close.** `WebRtcClient.Close` cancels
   locally but never tells the agent to tear down its peer, so the agent
   holds a dead `RTCPeerConnection` until the 12s watchdog trips.
3. **Cursor overlay missing on native admin.** Web console polls
   `session_cursors` and draws an SVG pointer; native admin skips this
   entirely, so the mouse ghost is invisible on the D3D surface.
4. **No power-command channel from admin console.** Backend has
   `power_commands` + `/api/public/agent/power/$cmdId/ack`, agent implements
   `PowerRelay`, but admin has no UI/API path to queue shutdown/restart/lock.

## Plan

### 1. Admin — close the four parity gaps
- `admin/src/Api/ApiClient.cs`:
  - Add `PollSessionCursorAsync(sessionId, ct)` → GET `/rest/v1/session_cursors?session_id=eq...&select=x,y,frame_w,frame_h,kind,visible,updated_at&limit=1`.
  - Add `EnqueuePowerCommandAsync(deviceRowId, kind, payload, ct)` → POST `/rest/v1/power_commands` (kind ∈ shutdown/restart/lock/logoff/wake).
  - Expose `App.Api.BindAdminAsync` reuse for the fallback pump (already public).
- `admin/src/Media/FrameFallbackPump.cs`: on start, kick a 15 s `bind_admin`
  heartbeat with the same `superseded → onTerminated` contract that
  `WebRtcClient` uses. Stops when the pump stops.
- `admin/src/Media/WebRtcClient.cs`: in `Close()`, best-effort
  `PushSignalReliableAsync(_sessionId, "bye", …)` before cancelling, so the
  agent tears down its peer immediately.
- `admin/src/Media/CursorOverlay.cs` (new, ~60 LOC): tiny WPF canvas overlay
  positioned over `D3DImageHost`, driven by a 200 ms
  `PollSessionCursorAsync` loop scaled from `frame_w/h` to the render size.
  Wired from the live-view window.

### 2. Agent — naming cleanup only, no route changes
- `agent/src/ApiClient.cs`: rename `PairResult / PairOk / PairErr` records
  to `ReconnectResult / ReconnectOk / ReconnectErr`. Purely a read-clarity
  fix; call sites in `App.xaml.cs` / `Agent.cs` updated in the same edit.
  No new endpoint calls.

### 3. Verifier — extend for the two new admin paths
- `scripts/verify-agent-routes.ts`: add smoke checks for
  `GET /rest/v1/session_cursors` and `POST /rest/v1/power_commands` against
  the published origin, asserting the auth gate (401) — proving both are
  mounted and RLS-guarded without an authed session.

### 4. Package both zips one after the other
- Extend `build.bat` with a `[3/3] Package` step that zips
  `agent\dist` → `ConnectLive-RemoteAgent.zip` and rebuilds
  `admin\dist` → `ConnectLive-AdminConsole.zip` (single-file, self-contained,
  win-x64) using PowerShell `Compress-Archive`.
- Confirm each zip locally, then output them sequentially.

### Technical notes (for the record)
- `bind_admin` RPC already exists and is idempotent — safe to call from
  both pumps concurrently; last writer wins with `admin_bound_at` refresh.
- `power_commands` RLS: `authenticated` insert scoped to `has_role(admin)`
  or `super_admin` — no schema change needed; admin console is already
  signed in via Supabase.
- No changes to `_authenticated/` routes, no new server functions, no DB
  migration in this pass.

```text
   backend                agent client              admin client
   /session/$id/signal ←→ PostSignalReliable   ←→   PushSignalReliable
   /session/$id/frame  ←→ PostFrame            ←→   FrameFallbackPump.Poll
   /session/$id/cursor ←→ PostCursor           ←→   CursorOverlay.Poll (new)
   power_commands      ←→ PowerRelay poll      ←→   EnqueuePowerCommand (new)
   rpc/bind_admin      ─────(agent doesn't)──  ←→   WebRtc + Fallback heartbeat
```
