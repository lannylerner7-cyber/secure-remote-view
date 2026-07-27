# Verify all routes & signal handshake — Agent (C#) ↔ Web ↔ Admin (C#)

Goal: prove every endpoint referenced by the two C# clients exists on the web backend with matching method, auth header, and payload shape — before we repack the zips. No code changes yet; this pass is read-only diffing plus a smoke script.

## What I already confirmed from the source

**Agent → server (`agent/src/ApiClient.cs`, `agent/watcher/Program.cs`)**
Every path used by the agent has a matching file under `src/routes/api/public/agent/`:


| Client call                               | Method          | Server file                       | Auth                 |
| ----------------------------------------- | --------------- | --------------------------------- | -------------------- |
| `/api/public/agent/enroll`                | POST            | `enroll.ts`                       | `X-Deployment-Key` ✅ |
| `/api/public/agent/hello`                 | POST            | `hello.ts`                        | device token         |
| `/api/public/agent/heartbeat`             | POST            | `heartbeat.ts`                    | device token         |
| `/api/public/agent/session/:id/reconnect` | POST            | `session.$sessionId.reconnect.ts` | device token         |
| `/api/public/agent/session/:id/consent`   | POST            | `session.$sessionId.consent.ts`   | device token         |
| `/api/public/agent/session/:id/frame`     | POST            | `session.$sessionId.frame.ts`     | device token         |
| `/api/public/agent/session/:id/cursor`    | POST            | `session.$sessionId.cursor.ts`    | device token         |
| `/api/public/agent/session/:id/inputs`    | GET (long-poll) | `session.$sessionId.inputs.ts`    | device token         |
| `/api/public/agent/session/:id/signal`    | POST + GET      | `session.$sessionId.signal.ts`    | device token         |
| `/api/public/agent/pair`                  | POST            | `pair.ts`                         | 410 Gone (legacy) ✅  |


**Admin → server (`admin/src/Api/ApiClient.cs`)**

- `POST /api/public/auth/login` → `src/routes/api/public/auth/login.ts` ✅
- Direct Supabase REST (with `apikey` + `Bearer <access_token>` — RLS as technician) against `devices`, `sessions`, `session_inputs`, `session_signals`, `session_frames`. All four tables are defined in migrations and typed in `src/integrations/supabase/types.ts`. ✅

**Central registry (`src/shared/api-routes.ts`)** matches both clients 1:1, incl. legacy `agentPair` marker.

## Verification steps (this pass only)

1. **Route/method parity table** — walk every `HttpRequestMessage` in the three C# files and every `fetch/xhr` in web admin, cross-check against `src/routes/api/public/**` file names and their `handlers.{METHOD}`. Flag any orphaned route (server has it, no client uses it) and any missing route (client calls it, server file absent or wrong method).
2. **Handshake shape check** — for enroll/hello/heartbeat/reconnect/consent/frame/cursor/inputs/signal: confirm request body keys and response JSON keys used by the C# deserializers match the server handlers (case-sensitive fields such as `deviceId`, `deviceToken`, `sessionId`, `mode`, `state`, `since`, `max`, `items[].from_side`).
3. **Auth header parity** — every `/api/public/agent/*` `enroll` + `pair`) `X-Device-Id` + `X-Device-Token`; `enroll` must require `X-Deployment-Key`; admin REST must send both `apikey` and `Authorization: Bearer`.
4. **Signal direction & session-state gates** — re-read `session.$sessionId.signal.ts`: POST inserts `from_side="agent"`, GET filters `from_side=eq.admin`, state must be `active`. Confirm admin's `PollAgentSignalsAsync` uses `from_side=eq.agent` (it does) and `PushSignalAsync` inserts `from_side="admin"` (it does).
5. **Smoke script** — reuse the pattern from `scripts/verify-payment-routes.ts` and add `scripts/verify-agent-routes.ts` that hits each `/api/public/agent/*` unauthenticated and asserts the expected 401/410/400 (not 404/500). Runs against `https://secure-remote-view.lovable.app`.
6. **Report** — output a single pass/fail matrix per route with the exact HTTP code observed. If everything is green, we proceed to repack the zips. If not, list the mismatches and propose the minimal fix (in a follow-up plan).

## Deliverable of this pass

- `scripts/verify-agent-routes.ts` (new, read-only smoke checker).
- A printed verification matrix in chat covering all 11 agent routes + 1 admin auth route + 6 Supabase REST tables.
- Explicit "no mismatches found → safe to repack" or a numbered list of defects.

No agent/admin/web source is modified in this step. Repackaging the two zips is a separate follow-up once the matrix is green.