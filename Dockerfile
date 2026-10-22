# ==========================================
# STAGE 1: Build
# ==========================================
FROM oven/bun:1.3.6-alpine AS builder

WORKDIR /app

# Cache deps
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Emit a Node server bundle (not the default Cloudflare Workers preset)
ENV NITRO_PRESET=node-server
# Public browser settings only. Never supply service-role, SMTP or TURN secrets
# as build arguments: those belong in Coolify runtime variables.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_PUBLISHABLE_KEY"
RUN bun run build

# ==========================================
# STAGE 2: Runtime
# ==========================================
FROM node:24-alpine AS runner

WORKDIR /app

# Coolify can replace Docker's HEALTHCHECK with its own curl-based probe.
# Keep curl available even though the built-in probe below uses Node.
RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV NITRO_PRESET=node-server
ENV HOST=0.0.0.0
ENV PORT=3000

# Nitro node-server output is self-contained
COPY --from=builder /app/.output ./.output

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 connectlive
USER connectlive

EXPOSE 3000

# Coolify zero-downtime health probe
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',{signal:AbortSignal.timeout(8000)}).then(async r=>{if(!r.ok||(await r.text()).trim()!=='OK')process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
