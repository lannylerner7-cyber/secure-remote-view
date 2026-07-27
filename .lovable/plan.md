## Goal

Make the admin panel + backend self-deployable on Coolify with zero-downtime health checks, while respecting the actual stack (TanStack Start v1 + Vite + Nitro, not raw Express).

## Stack reality check (adjustments vs. the pasted snippet)

- No `dist/server.js` Express entry. `vite build` produces a Nitro server bundle under `.output/`. Default preset is Cloudflare Workers via `@lovable.dev/vite-tanstack-config`.
- For Coolify (Node container), Nitro must emit a Node server. We'll set `NITRO_PRESET=node-server` at build time so the output is `.output/server/index.mjs` listening on `PORT`.
- Package manager is `bun` in this repo but `npm ci` works from `package-lock.json` if present; we'll use `bun` to match the toolchain and drop the need for a lockfile mismatch.
- Env vars: repo already uses `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (not `_ANON_KEY`). Sample will match.

## Files to add

### 1. `Dockerfile` (multi-stage, Node 20 alpine, non-root, healthcheck)

- Stage `builder`: install bun, `bun install --frozen-lockfile` (fallback `bun install`), copy source, `NITRO_PRESET=node-server bun run build`.
- Stage `runner`: copy `.output/` only, run as non-root `connectlive:1001`, `EXPOSE 3000`, `ENV PORT=3000 HOST=0.0.0.0 NITRO_PRESET=node-server`.
- `HEALTHCHECK` uses `wget --spider http://localhost:3000/health`.
- `CMD ["node", ".output/server/index.mjs"]`.

### 2. `.env.sample`

Template with the real variable names this codebase reads:

```
PORT=3000
NODE_ENV=production
NITRO_PRESET=node-server

VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
VITE_SUPABASE_PROJECT_ID=your-project-id

SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxx

# Optional TURN
# TURN_SERVER_URL=
# TURN_SERVER_USER=
# TURN_SERVER_SECRET=
```

### 3. `.dockerignore`

Exclude `node_modules`, `.output`, `.git`, `agent/`, `public/ConnectLiveAgent.zip` build artifacts, `/mnt`, `.env*`, editor files — keeps image small.

### 4. Health route: `src/routes/api/public/health.ts`

Lightweight TanStack file route (public prefix bypasses auth), returns `200 OK` plain text. No DB call. Path: `/api/public/health`.

Because Coolify's example hits `/health`, we'll also add `src/routes/health.ts` as a plain file route returning `new Response('OK')` so both `/health` and `/api/public/health` work. Dockerfile HEALTHCHECK will target `/health`.

### 5. `COOLIFY.md` (short deploy notes)

- Build Pack: Dockerfile
- Exposed port: 8000
- Env vars to paste (from `.env.sample`)
- Note: `NITRO_PRESET=node-server` is required so the Cloudflare Workers preset isn't used
- Point out that agent binaries live under `agent/` and are unrelated to this container.

## Out of scope

- No changes to Supabase clients, agent code, admin UI, or existing API routes.
- Not switching the Lovable-hosted deployment; this only enables self-hosting on Coolify in parallel.

## Technical details

- Nitro Node preset emits `.output/server/index.mjs` and serves static assets from `.output/public/`. Listening host/port come from `HOST`/`PORT` env vars.
- `vite.config.ts` uses `@lovable.dev/vite-tanstack-config`; setting `NITRO_PRESET` env is honored by Nitro during `vite build` without editing the config.
- Health route under `src/routes/health.ts` uses `createFileRoute('/health')({ server: { handlers: { GET: () => new Response('OK') } } })` — no auth, no DB.