# Codebase / route / key verification pass

Full read of every route file, every endpoint string in the agent and admin sources, and every environment key the code reads versus what is actually configured. Findings below, ordered by impact.

## Findings

### V1 — TURN is dead for every technician console (high impact, confirmed)
`src/routes/api/public/agent/ice.ts` authenticates technicians by reading `SUPABASE_URL` + `SUPABASE_ANON_KEY`. `SUPABASE_ANON_KEY` is not set anywhere — the project ships `SUPABASE_PUBLISHABLE_KEY` instead (that is why `agent/release.ts` already reads `SUPABASE_PUBLISHABLE_KEY ?? SUPABASE_ANON_KEY`).

Consequence: `verifyTechnician` always returns false, so both consoles get 401 from the ICE gateway:
- native admin (`admin/src/Media/WebRtcClient.cs` line ~148) logs `ice gateway failed` and falls back to a single Google STUN entry;
- web console (`src/lib/webrtc-live.ts` `fetchIceServers`) falls back to `STUN_SERVERS`.

So the Cloudflare Calls TURN credentials we wired in S9 are only ever reachable by the agent side, and any symmetric-NAT session silently degrades to JPEG. Fix: mirror the release-route fallback in `ice.ts`.

### V2 — Stale secrets still provisioned
- `AGENT_DEPLOYMENT_KEY` — removed from the product during the enrollment overhaul; no code reads it. Delete.
- `CRON_SECRET` — the cron route now validates against the `cron_tokens` table, not env. No code reads it. Delete.

Both are dead credentials sitting in the environment; removing them keeps the secret surface honest.

### V3 — Route inventory: no ghosts, one coverage hole
Every endpoint string in `agent/` and `admin/` resolves to a real file under `src/routes/api/public/`, and every entry in `src/shared/api-routes.ts` exists. `scripts/verify-agent-routes.ts` however only probes 8 of the endpoints; the per-session family (`signal`, `inputs`, `frame`, `cursor`, `consent`, `reconnect`, `power ack`) is never touched by the verifier, so a regression there is invisible until a live session fails. Extend the verifier with an unauthenticated-probe pass (expect 401/404, not 500) for those seven.

### V4 — Missing head metadata
`src/routes/_authenticated/route.tsx` has no `head()`. Every other page route defines one. It is the console shell, so a `noindex` head is the right fix rather than a marketing title.

### V5 — Keys that are correctly absent
`TURN_URLS` / `TURN_STATIC_SECRET` / `TURN_USERNAME` / `TURN_PASSWORD` are the coturn fallback path and are intentionally unset while Cloudflare is configured. `SUPABASE_SERVICE_ROLE_KEY` appears only in `scripts/e2e-wake.ts`, a local operator script — not a runtime dependency. No action.

## What to change

1. `src/routes/api/public/agent/ice.ts` — read `SUPABASE_PUBLISHABLE_KEY ?? SUPABASE_ANON_KEY`; log once (not per request) when neither is present so the failure is diagnosable instead of silent.
2. Delete secrets `AGENT_DEPLOYMENT_KEY` and `CRON_SECRET`.
3. `scripts/verify-agent-routes.ts` — add the seven session-scoped routes to the probe table with expected-status assertions.
4. `src/routes/_authenticated/route.tsx` — add `head()` with a console title and `robots: noindex`.
5. `PROJECT-MAP.md` — new §10.8 recording V1 as a shipped fix, the two retired secrets, and the widened route verifier, so the ICE-auth key name is pinned as an invariant.

No agent or admin C# changes are required: both already handle an empty ICE set gracefully, and they start using TURN the moment the gateway stops returning 401.
