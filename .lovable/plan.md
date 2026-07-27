# Route & Resilience Audit — Admin ↔ Agent ↔ Watcher

Read every route call site in `agent/src/ApiClient.cs`, `agent/watcher/Program.cs`, and `admin/src/**` against the server routes in `src/routes/api/public/**` and `src/shared/api-routes.ts`. Findings and the small tightening pass below.

## 1. Endpoint parity — 100% matched

### Agent → Server (`agent/src/ApiClient.cs` + watcher)
| Call | Server file | Status |
| --- | --- | --- |
| `POST /api/public/agent/enroll` (X-Deployment-Key) | `agent/enroll.ts` | ✅ |
| `POST /api/public/agent/hello` | `agent/hello.ts` | ✅ |
| `POST /api/public/agent/heartbeat` (watcher + agent) | `agent/heartbeat.ts` | ✅ |
| `POST /api/public/agent/session/{id}/reconnect` | `session.$sessionId.reconnect.ts` | ✅ |
| `POST /api/public/agent/session/{id}/consent` | `session.$sessionId.consent.ts` | ✅ (kept for legacy; auto-activation) |
| `POST /api/public/agent/session/{id}/frame` | `session.$sessionId.frame.ts` | ✅ |
| `POST /api/public/agent/session/{id}/cursor` | `session.$sessionId.cursor.ts` | ✅ |
| `GET  /api/public/agent/session/{id}/inputs?since=` | `session.$sessionId.inputs.ts` | ✅ |
| `POST /api/public/agent/session/{id}/signal` | `session.$sessionId.signal.ts` | ✅ |
| `GET  /api/public/agent/session/{id}/signal?since=` | `session.$sessionId.signal.ts` | ✅ |
| `POST /api/public/agent/pair` | `agent/pair.ts` (410 Gone) | ✅ intentionally dead |

### Admin → Server (`admin/src/Api/ApiClient.cs`)
| Call | Target | Status |
| --- | --- | --- |
| `POST /api/public/auth/login` | `auth/login.ts` (3-strike lockout) | ✅ |
| `POST {supabase}/auth/v1/token?grant_type=refresh_token` | Supabase Auth | ✅ |
| `GET/DELETE /rest/v1/devices` | RLS (staff) | ✅ |
| `POST/PATCH /rest/v1/sessions` | RLS | ✅ |
| `POST /rest/v1/session_inputs` | RLS | ✅ |
| `POST + GET /rest/v1/session_signals` | RLS (fallback poll) | ✅ |
| `GET /rest/v1/session_frames` (HTTPS fallback) | RLS | ✅ |

No orphan route on server, no missing route in either client.

## 2. Retry / resilience mesh

**Watcher (`agent/watcher/Program.cs`)** — persistent SYSTEM service:
- Heartbeat back-off `5→10→20→40→60s`, resets on 2xx.
- Detects fast-user-switch via `WTSGetActiveConsoleSessionId` and respawns worker in the new session.
- Detects worker exit (`HasExited`) each tick and re-launches via `CreateProcessAsUser` — this is the "auto-execute even if agent was killed" path the user asked about. ✅
- Enrolls silently on first tick if creds are missing.

**Agent (`Agent.cs` / `App.xaml.cs`)**:
- Cold-boot: DPAPI-restore last session → `/reconnect` before idling.
- Heartbeat loop with 1→2→4→8→16→30s back-off.
- `EnsureSessionLoops` self-heals capture / cursor / input / signal loops on unexpected exit.

**Admin (`admin/src/**`)**:
- `ApiClient.SendSupabaseAsync` auto-refreshes and retries on 401. ✅
- `DevicesViewModel.PollLoop` polls every 5s.
- `WebRtcClient` re-offers every 12s while unconnected, polls agent signals every 500ms.
- `FrameFallbackPump` pulls latest JPEG every 200ms until WebRTC links.

## 3. Small tightening pass (only changes in this plan)

1. **`agent/watcher/Program.cs` L141** — remove dead `|| true` in `(isSessionActive || true)`; keep unconditional spawn but drop the misleading expression + add comment that this is intentional (tray must appear at login even before an admin session exists).
2. **`admin/src/ViewModels/DevicesViewModel.cs` `PollLoop`** — add exponential back-off (5→10→20→30s cap) on consecutive `Refresh()` failures so a flaky network doesn't hammer the gateway; reset on success. Mirrors the watcher pattern.
3. **`admin/src/Media/WebRtcClient.cs` `PollAgentSignals`** — wrap the loop body's `PollAgentSignalsAsync` in try/catch that only sleeps 500ms on success and 2s on error, so a transient 5xx doesn't spin.
4. **`src/shared/api-routes.ts`** — add `agentPair` (410 legacy) entry so the registry documents every reachable path, plus a top-of-file comment listing the two client consumers (agent C# / admin C#) that must stay in sync.

No server route, schema, RLS policy, auth flow, or UI behavior changes. Purely a documented audit + three defensive client tweaks.

## Out of scope
- Moving frames off Postgres onto Realtime/Storage.
- TURN, DXGI, or H.264 pinning (previously planned separately).
- Any change to the payment / order surface.
