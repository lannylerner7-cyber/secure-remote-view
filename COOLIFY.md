# Deploying ConnectLive to Coolify

The repo ships a production `Dockerfile` that builds the TanStack Start app
into a Node server bundle (via Nitro's `node-server` preset) and runs it as a
non-root user with a `/health` probe wired for zero-downtime deploys.

## 1. Create the resource
- **Build Pack:** `Dockerfile`
- **Exposed Port:** `3000` (must match `EXPOSE 3000` in the Dockerfile)
- **Health Check Path:** `/health` (Coolify + the Docker `HEALTHCHECK` both hit this)

## 2. Environment variables
Copy `.env.sample` into Coolify's Environment Variables tab and replace the
placeholder values with your real production keys. Required:

- `PORT=3000`
- `NODE_ENV=production`
- `NITRO_PRESET=node-server`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

`VITE_*` values are baked in at build time, so any change to them requires a
rebuild. Server-only values (`SUPABASE_SERVICE_ROLE_KEY`, etc.) are read at
request time and can be rotated without rebuilding.

## 3. Health endpoints
- `GET /health` → `200 OK` (Dockerfile `HEALTHCHECK` uses this)
- `GET /api/public/health` → `200 OK` (mirror for external monitors)

Neither route touches the database, so probes stay cheap.

## 4. Notes
- The Windows agent binaries live under `agent/` and are unrelated to this
  container — they are excluded via `.dockerignore`.
- The default Lovable-hosted deploy uses the Cloudflare Workers preset; this
  Dockerfile is only used when self-hosting on Coolify (or any Node host).
