import { createFileRoute } from "@tanstack/react-router";
import { createHmac } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * S9 — ICE configuration gateway.
 *
 * Both peers used to hardcode a public STUN server, so any symmetric-NAT or
 * egress-filtered network silently degraded to the JPEG fallback. This route
 * is the single source of truth for the ICE server set:
 *
 *   - always returns the STUN set;
 *   - prefers Cloudflare Calls TURN when CLOUDFLARE_CALLS_APP_ID and
 *     CLOUDFLARE_CALLS_APP_TOKEN are configured. Credentials are minted
 *     per-request through the Cloudflare API, so no long-lived secret lives
 *     in the agent or admin console.
 *   - falls back to coturn REST credentials (use-auth-secret) when Cloudflare
 *     is not configured, then to static TURN_USERNAME / TURN_PASSWORD.
 *
 * Callers: agent (X-Device-Id + X-Device-Token) and technician consoles
 * (Supabase bearer JWT). Unauthenticated callers get 401 — TURN relay minutes
 * are billable and must never be handed to the open internet.
 */

const STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

const TTL_SECONDS = 12 * 60 * 60;

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * V1 — the publishable key is the deployed name; SUPABASE_ANON_KEY is the
 * legacy alias and is not set on this project. Reading only the legacy name
 * made every technician console 401 here and silently lose TURN. Warn once so
 * a future rename is diagnosable instead of invisible.
 */
let warnedMissingKey = false;

async function verifyTechnician(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!token) return false;
  const url = process.env["SUPABASE_URL"];
  const anon =
    process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"];
  if (!url || !anon) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.error(
        "[ice] technician auth disabled: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) must be set — consoles will fall back to STUN-only",
      );
    }
    return false;
  }
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  return !error && !!data.user;
}

async function buildCloudflareTurnServers(peer: string): Promise<IceServer[]> {
  const appId = process.env["CLOUDFLARE_CALLS_APP_ID"];
  const token = process.env["CLOUDFLARE_CALLS_APP_TOKEN"];
  if (!appId || !token) return [];

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${appId}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`Cloudflare TURN credential request failed [${res.status}]: ${body}`);
    return [];
  }

  const data = await res.json();
  // Cloudflare returns { iceServers: { urls, username, credential } }.
  // Defensively normalise in case the envelope ever changes.
  const rawServers = Array.isArray(data.iceServers)
    ? data.iceServers
    : data.iceServers
      ? [data.iceServers]
      : Array.isArray(data)
        ? data
        : [];

  const servers: IceServer[] = [];
  for (const s of rawServers) {
    if (!s) continue;
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls].filter(Boolean);
    if (urls.length === 0) continue;
    servers.push({ urls, username: s.username, credential: s.credential });
  }

  if (servers.length > 0) {
    console.log(`Cloudflare TURN credentials minted for peer=${peer}`);
  }
  return servers;
}

function buildCoturnServers(peer: string): IceServer[] {
  const raw = process.env["TURN_URLS"];
  if (!raw) return [];
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) return [];

  const secret = process.env["TURN_STATIC_SECRET"];
  if (secret) {
    const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const username = `${expiry}:${peer}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    return [{ urls, username, credential }];
  }

  const username = process.env["TURN_USERNAME"];
  const credential = process.env["TURN_PASSWORD"];
  if (username && credential) return [{ urls, username, credential }];

  // URLs without any credential source would produce a dead relay entry.
  return [];
}

async function buildTurnServers(peer: string): Promise<IceServer[]> {
  const cloudflare = await buildCloudflareTurnServers(peer);
  if (cloudflare.length > 0) return cloudflare;
  return buildCoturnServers(peer);
}

export const Route = createFileRoute("/api/public/agent/ice")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const device = await verifyDevice(request);
        let peer: string | null = device ? `agent-${device.device.device_id}` : null;
        if (!peer && (await verifyTechnician(request))) peer = "admin";
        if (!peer) return new Response("unauthorized", { status: 401 });

        const turn = await buildTurnServers(peer);
        return Response.json(
          {
            iceServers: [{ urls: STUN_URLS }, ...turn],
            turn: turn.length > 0,
            ttlSeconds: TTL_SECONDS,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
