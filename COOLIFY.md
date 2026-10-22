# Deploying ConnectLive to Coolify

The repo ships a production `Dockerfile` that builds the TanStack Start app
into a Node server bundle (via Nitro's `node-server` preset) and runs it as a
non-root user with a `/health` probe wired for zero-downtime deploys.

## 1. Create the resource
- **Build Pack:** `Dockerfile`
- **Exposed Port:** `3000` (must match `EXPOSE 3000` in the Dockerfile)
- **Health Check Path:** `/health` (Coolify + the Docker `HEALTHCHECK` both hit this)
- **Health Check Host / Port:** `127.0.0.1` / `3000`, HTTP, GET, expected status `200`.
- **Health Check Start Period:** `30` seconds; timeout `10` seconds.
- **Domain:** `https://connectliveagent.com` routes HTTPS 443 to container port
  3000. Do not map the Replit preview port 21268 into Coolify.
- **Build context:** repository root when this imported code is the repository
  root; `imports/connectlive` when using the entire Replit workspace repository.
  Dockerfile path is relative to that build context.
- **Auto-deploy:** a GitHub push may trigger Coolify if enabled. Confirm that
  policy before merging a release branch; this check does not change it.

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

Mark `VITE_*` as build-time variables/build arguments in Coolify. The Dockerfile
explicitly accepts the three public Supabase arguments and fails if URL/key is
missing. Never mark service-role, SMTP, session or Cloudflare secrets as public
build arguments. See `docs/coolify-configuration-guide.md` in the Replit workspace
for the full runtime inventory, including `SESSION_SECRET_KEY` and SMTP/TURN.
The build uses Bun 1.3.6 with its checked-in text lockfile and no unlocked fallback;
runtime uses Node 24.

## 3. Health endpoints
- `GET /health` → `200 OK` (Dockerfile `HEALTHCHECK` uses this)
- `GET /api/public/health` → `200 OK` (mirror for external monitors)

Neither route touches the database, so probes stay cheap.

The container probe follows `PORT` (default 3000), performs GET rather than HEAD
and requires the `OK` body. For a custom port, change both `PORT` and Coolify's
exposed/target port together.

Coolify may override the Dockerfile probe with a generated curl/wget command.
The runtime image includes curl for that case. Use `127.0.0.1`, not `localhost`,
to avoid resolving an IPv6 loopback when the server is listening on IPv4.
Do not disable health checks to hide a failing probe. If it still refuses the
connection, inspect the container's runtime logs, effective PORT/HOST and the
actual probe command; an image build success does not establish runtime health.

Before deploying, confirm the selected Git branch and commit contain the updated
Dockerfile. A source push to a review branch does not update `main` automatically.

## 4. Connection ports

| Traffic | Direction / mapping |
| --- | --- |
| Web, REST API, SSE signaling | HTTPS 443 through Coolify proxy to HTTP 3000 |
| Supabase REST/Auth/Realtime | Outbound HTTPS/WSS 443 to the managed project |
| Cloudflare credential API | Server outbound HTTPS 443; never expose the API token |
| TURN/STUN media | Clients use the UDP/TCP/TLS URLs returned by ICE; do not proxy RTP/DXGI through port 3000 |
| SMTP | Server outbound TLS 465 for the configured provider |

Preserve long-lived SSE responses in the proxy (no response buffering or short
idle timeouts). The ordinary HTTP health probe does not test this or TURN media.

## 5. Notes
- The Windows agent binaries live under `agent/` and are unrelated to this
  container — they are excluded via `.dockerignore`.
- The default Lovable-hosted deploy uses the Cloudflare Workers preset; this
  Dockerfile is only used when self-hosting on Coolify (or any Node host).
