## Route audit: agent ↔ watcher ↔ backend

Cross-checked every URL the agent, watcher, `src/shared/api-routes.ts` registry, and admin panel touch against the actual handler files under `src/routes/api/public/`. Four mismatches would cause silent runtime failures — the rest matches.

### Findings

| # | Caller | Route | Backend handler | Status |
|---|---|---|---|---|
| 1 | `agent/src/ApiClient.cs:122` (`PairAsync`) | `POST /api/public/agent/pair` | Returns **410 Gone** after auto-enroll rewrite | ❌ dead call still shipped |
| 2 | `agent/src/ApiClient.cs:274` (`ConnectRealtimeAsync`) | `WS /api/ws?deviceId&token` | **No route file exists** | ❌ WS connect will 404 |
| 3 | `src/shared/api-routes.ts:14` (`agentSessionPoll`) | `GET /api/public/agent/session/:id` | **No handler** (only `.consent`, `.frame`, etc. leaves exist) | ❌ registry entry lies |
| 4 | `src/routes/_authenticated/console.tsx` (10+ sites) | Generates/shows `pairing_code`, "Show code" modal, pending-invite banner | Pairing is deprecated | ❌ leftover UI from old flow |
| ✅ | `enroll`, `hello`, `heartbeat`, `session/:id/consent`, `/reconnect`, `/frame`, `/cursor`, `/inputs`, `/signal` | — | Handler files present | OK |
| ✅ | Watcher `/heartbeat` + `/enroll` (Program.cs:104,220) | — | Match | OK |
| ✅ | `X-Device-Id` + `X-Device-Token` headers on every authed call, `X-Deployment-Key` only on `/enroll` | — | Match `agent-auth.server.ts` + `enroll.ts` | OK |

### Fixes

1. **Remove dead pair path from the agent.**
   - Delete `PairAsync` + `PairResult`/`PairOk`/`PairErr` records in `agent/src/ApiClient.cs`.
   - Drop the `/api/public/agent/pair` line from the header doc-block.
   - `JoinWindow.cs` is already unused after the auto-enroll cutover — remove its `<Compile>` if referenced or leave dormant (it's not wired from `App.xaml.cs` anymore).

2. **Decide the realtime transport.** The agent's main loop uses HTTP long-poll (`PollSignalsAsync`, `PollInputsAsync`) — the WebSocket path is optional. Two options, need your call:
   - **A. Drop it** — remove `ConnectRealtimeAsync` from `ApiClient.cs` and the `using var ws = ...` block in `Agent.cs:92`. Simpler, one less surface. Recommended since polling already works end-to-end.
   - **B. Implement it** — add `src/routes/api/ws.ts` server route that validates `deviceId`+`token` against `agent-auth.server.ts` and bridges to a Supabase Realtime channel. Bigger change; only worth it if you want push-based signaling.

3. **Reconcile `agentSessionPoll` in `src/shared/api-routes.ts`.** Either remove the entry (agent never calls it) or add a thin `GET /api/public/agent/session/:id` handler returning `{state, mode}` for future use. Remove is safer.

4. **Strip pairing UI from `src/routes/_authenticated/console.tsx`.**
   - Delete the "Show code" buttons, the pending-invite banner (line ~421+), the code-modal state, and the `pairing_code` column in the sessions table.
   - When a session is created for an auto-enrolled device, skip the code generation branch entirely — session goes straight to `invited` and the watcher picks it up on the next heartbeat.
   - Keep the `pairing_code` DB column (harmless, per the earlier plan).

5. **Sanity script.** Add a small `scripts/verify-routes.ts` that greps `API_ROUTES` values + `agent/src/**/*.cs` route literals against `src/routes/api/public/**` handler files and fails CI on any mismatch. Prevents this class of drift returning.

### Deliverables

- Patched `agent/src/ApiClient.cs`, `agent/src/Agent.cs` (WS block removed if 2A), `src/shared/api-routes.ts`, `src/routes/_authenticated/console.tsx`.
- New `scripts/verify-routes.ts` + a one-line npm script.
- Rebuilt `ConnectLiveAgent.zip` and refreshed `agent/INSTALL.md` mentioning the removed pair/WS paths.

### One decision needed

For step 2, do you want to **drop the WebSocket path (recommended)** or **implement the missing `/api/ws` route**?
