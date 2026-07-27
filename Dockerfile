# ==========================================
# STAGE 1: Build
# ==========================================
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Cache deps
COPY package.json bun.lockb* bunfig.toml* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Emit a Node server bundle (not the default Cloudflare Workers preset)
ENV NITRO_PRESET=node-server
RUN bun run build

# ==========================================
# STAGE 2: Runtime
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

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
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", ".output/server/index.mjs"]
