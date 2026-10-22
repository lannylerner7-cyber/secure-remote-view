import { createFileRoute } from "@tanstack/react-router";
import { createHmac } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { verifyDevice } from "@/lib/agent-auth.server";
import { adminClient } from "@/lib/server-supabase";
import { sessionAuthorized } from "@/lib/authorization.server";

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
 *     is unavailable or not configured, then to static TURN_USERNAME /
 *     TURN_PASSWORD. With no usable relay credentials, turn is explicitly
 *     false and the response contains only the STUN set.
 *
 * Callers: agent (X-Device-Id + X-Device-Token) and technician consoles
 * (Supabase bearer JWT). Both must supply sessionId and pass active-session
 * ownership and recorded view-grant checks. User callers also require a
 * technician/admin role. Principal mint budgets apply after authorization.
 * Unauthenticated callers get 401 — TURN relay minutes are billable.
 */

const STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

const TTL_SECONDS = 12 * 60 * 60;
// One deadline covers both endpoint variants AND response-body parsing.
const TURN_PROVIDER_TIMEOUT_MS = 5_000;

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * V1 — the publishable key is the deployed name; SUPABASE_ANON_KEY is the
 * legacy alias and is not set on this project. Reading only the legacy name
 * made every technician console 401 here and silently lose TURN. Warn once so
 * a future rename is diagnosable instead of invisible.
 */
let warnedMissingKey = false;

async function verifyTechnician(request: Request): Promise<string | null> {
  const auth = request.headers.get("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;
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
    return null;
  }
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  return !error && data.user ? data.user.id : null;
}

// Per-process admission control, bounded memory; authorization is rechecked on
// every request. Multi-replica deployments must also configure an edge limit.
const mintWindows = new Map<string, { until: number; count: number }>();
function admitMint(peer: string): boolean {
  const now = Date.now();
  for (const [key, entry] of mintWindows)
    if (entry.until <= now) mintWindows.delete(key);
  const entry = mintWindows.get(peer);
  if (entry) return ++entry.count <= 10;
  if (mintWindows.size >= 10_000) return false;
  mintWindows.set(peer, { until: now + 60_000, count: 1 });
  return true;
}

async function authorizeRelay(request: Request): Promise<{ peer: string } | Response> {
  const deny = (status: number) => new Response(null, {
    status, headers: { "cache-control": "no-store" },
  });
  try {
    const device = await verifyDevice(request);
    const userId = device ? null : await verifyTechnician(request);
    if (!device && !userId) return deny(401);
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
      return deny(400);
    const admin = device?.admin ?? adminClient();
    const { data: session, error } = await admin.from("sessions")
      .select("id, device_id, technician_id, state").eq("id", sessionId).maybeSingle();
    if (error) return deny(503);
    if (!session || session.state !== "active") return deny(403);
    if (device) {
      if (session.device_id !== device.device.id) return deny(403);
    } else {
      const { data: roles, error: roleError } = await admin.from("user_roles")
        .select("role").eq("user_id", userId!);
      if (roleError) return deny(503);
      const allowed = (roles ?? []).some(r => ["technician", "admin", "super_admin"].includes(r.role));
      const isSuper = (roles ?? []).some(r => r.role === "super_admin");
      if (!allowed || (session.technician_id !== userId && !isSuper)) return deny(403);
    }
    if (!(await sessionAuthorized(admin, sessionId, "view"))) return deny(403);
    return { peer: device ? `agent-${device.device.id}` : `admin-${userId}` };
  } catch {
    return deny(503);
  }
}

function normalizeCloudflareServers(data: unknown): IceServer[] {
  const envelope =
    data && typeof data === "object" && "iceServers" in data
      ? data.iceServers
      : data;
  const rawServers = Array.isArray(envelope) ? envelope : [envelope];
  const servers: IceServer[] = [];
  for (const raw of rawServers) {
    if (!raw || typeof raw !== "object") continue;
    const urls = Array.isArray(raw.urls) ? raw.urls : [raw.urls];
    if (
      urls.length === 0 ||
      !urls.every(
        (url: unknown) =>
          typeof url === "string" && /^(stun|stuns|turn|turns):[^\s]+$/i.test(url),
      )
    ) continue;
    const hasTurn = urls.some((url: string) => /^turns?:/i.test(url));
    if (
      hasTurn &&
      (typeof raw.username !== "string" || !raw.username.trim() ||
        typeof raw.credential !== "string" || !raw.credential.trim())
    ) continue;
    servers.push(
      hasTurn
        ? { urls, username: raw.username, credential: raw.credential }
        : { urls },
    );
  }
  // A STUN-only provider response must not be reported as successful TURN.
  return servers.some((server) =>
    (server.urls as string[]).some((url) => /^turns?:/i.test(url)),
  ) ? servers : [];
}

async function buildCloudflareTurnServers(signal: AbortSignal): Promise<IceServer[]> {
  const appId = process.env["CLOUDFLARE_CALLS_APP_ID"];
  const token = process.env["CLOUDFLARE_CALLS_APP_TOKEN"];
  if (!appId || !token || signal.aborted) return [];

  // Cloudflare renamed the mint endpoint: `generate-ice-servers` is current,
  // `generate` is legacy. Only retry endpoint incompatibility, not auth,
  // rate-limit, or service failures.
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, TURN_PROVIDER_TIMEOUT_MS);
  let rejectOnAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(new Error("TURN provider request cancelled"));
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    const mint = async (): Promise<IceServer[]> => {
      for (const path of ["credentials/generate-ice-servers", "credentials/generate"]) {
        if (controller.signal.aborted) return [];
        const attempt = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(appId)}/${path}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ttl: TTL_SECONDS }),
            signal: controller.signal,
            redirect: "error",
          },
        );
        if (controller.signal.aborted) {
          void attempt.body?.cancel().catch(() => {});
          return [];
        }
        if (!attempt.ok) {
          // Never read or log a provider error body: it can contain secrets.
          void attempt.body?.cancel().catch(() => {});
          console.warn(`[ice] Cloudflare TURN mint failed: HTTP ${attempt.status}`);
          if (attempt.status === 404 || attempt.status === 405) continue;
          return [];
        }
        const servers = normalizeCloudflareServers(await attempt.json());
        if (controller.signal.aborted) return [];
        if (servers.length === 0) {
          console.warn("[ice] Cloudflare TURN returned no valid relay credentials");
        }
        return servers;
      }
      return [];
    };
    // Race as well as abort: the caller remains bounded even if an adapter
    // ignores AbortSignal. Native fetch also stops downloading the body.
    return await Promise.race([mint(), cancelled]);
  } catch {
    if (!signal.aborted) {
      console.warn(
        controller.signal.aborted
          ? "[ice] Cloudflare TURN request timed out"
          : "[ice] Cloudflare TURN request failed",
      );
    }
    return [];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

function buildCoturnServers(peer: string): IceServer[] {
  const raw = process.env["TURN_URLS"];
  if (!raw) return [];
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter((url) => /^turns?:[^\s]+$/i.test(url));
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

async function buildTurnServers(peer: string, signal: AbortSignal): Promise<IceServer[]> {
  const cloudflare = await buildCloudflareTurnServers(signal);
  if (signal.aborted) return [];
  if (cloudflare.length > 0) return cloudflare;
  const coturn = buildCoturnServers(peer);
  if (coturn.length === 0) {
    console.warn("[ice] TURN unavailable; returning STUN-only configuration");
  }
  return coturn;
}

export const Route = createFileRoute("/api/public/agent/ice")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let authTimer: ReturnType<typeof setTimeout> | undefined;
        // Budget the auth/database phase separately; total is below native and
        // browser 12-second deadlines even when the provider uses all five.
        const authorization = await Promise.race([
          authorizeRelay(request),
          new Promise<Response>(resolve => {
            authTimer = setTimeout(() => resolve(new Response(null, {
              status: 503, headers: { "cache-control": "no-store" },
            })), 4_000);
          }),
        ]).finally(() => { if (authTimer) clearTimeout(authTimer); });
        if (authorization instanceof Response) return authorization;
        if (request.signal.aborted) return new Response(null, {
          status: 499, headers: { "cache-control": "no-store" },
        });
        const { peer } = authorization;
        if (!admitMint(peer)) return new Response(null, {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        });

        const turn = await buildTurnServers(peer, request.signal);
        if (request.signal.aborted) {
          return new Response(null, { status: 499, headers: { "cache-control": "no-store" } });
        }
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
