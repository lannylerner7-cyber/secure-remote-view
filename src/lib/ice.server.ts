/**
 * Server-issued ICE configuration.
 *
 * Every peer (web console, agent, native admin console) asks the backend for
 * its ICE servers instead of hardcoding them. Two reasons:
 *
 *   1. TURN credentials are short-lived and must never sit in a client binary
 *      or JS bundle. Metered issues per-request username/credential pairs; we
 *      cache them server-side only.
 *   2. STUN-only means no relay candidate is ever gathered, so any pair that
 *      can't hole-punch (symmetric NAT, corporate firewall, CGNAT) never
 *      completes ICE. TURN is the reliability fix.
 *
 * Degradation is deliberate: if Metered errors or the secrets are missing we
 * return STUN-only with hasTurn=false rather than failing the request. A TURN
 * outage must never block a session that could have connected directly.
 */

export interface IceServerDto {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigDto {
  iceServers: IceServerDto[];
  hasTurn: boolean;
  /** Watchdog ceiling in ms the client should use for "ICE never left new/gathering". */
  connectTimeoutMs: number;
}

const PUBLIC_STUN: IceServerDto[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** Metered credentials live ~1h; refresh comfortably inside that. */
const CACHE_TTL_MS = 50 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;

let cache: { value: IceConfigDto; expiresAt: number } | null = null;
let inflight: Promise<IceConfigDto> | null = null;

function stunOnly(): IceConfigDto {
  return { iceServers: [...PUBLIC_STUN], hasTurn: false, connectTimeoutMs: 10_000 };
}

/**
 * The app name may be saved as "zoomlite", "zoomlite.metered.live", or even a
 * full URL. Normalise all three to the bare subdomain so we never build
 * "zoomlite.metered.live.metered.live" (which fails TLS on Metered's CDN).
 */
function normalizeApp(raw: string): string {
  let app = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  app = app.replace(/\.metered\.live$/i, "");
  return app;
}

async function fetchMetered(rawApp: string, key: string): Promise<IceConfigDto> {
  const app = normalizeApp(rawApp);
  if (!app) return stunOnly();
  const url = `https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) {
      console.warn("[ice] metered responded", res.status);
      return stunOnly();
    }
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) {
      console.warn("[ice] metered returned unexpected shape");
      return stunOnly();
    }
    const turn: IceServerDto[] = [];
    for (const entry of raw) {
      const e = entry as { urls?: unknown; username?: unknown; credential?: unknown };
      if (typeof e.urls !== "string" || e.urls.length === 0) continue;
      // Metered's list already includes its own stun: entries; keep them, they
      // are closer to the relay edge than the Google fallback.
      if (e.urls.startsWith("turn:") || e.urls.startsWith("turns:")) {
        if (typeof e.username !== "string" || typeof e.credential !== "string") continue;
        turn.push({ urls: e.urls, username: e.username, credential: e.credential });
      } else if (e.urls.startsWith("stun:")) {
        turn.push({ urls: e.urls });
      }
    }
    const hasTurn = turn.some((s) => String(s.urls).startsWith("turn"));
    if (!hasTurn) {
      console.warn("[ice] metered list contained no turn: entries");
      return stunOnly();
    }
    return {
      iceServers: [...PUBLIC_STUN, ...turn],
      hasTurn: true,
      // Relayed gathering + allocation legitimately takes longer than a direct
      // hole-punch. See the watchdog rules in webrtc-live.ts.
      connectTimeoutMs: 20_000,
    };
  } catch (err) {
    console.warn("[ice] metered fetch failed", (err as Error)?.message);
    return stunOnly();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the ICE configuration handed to every peer. Cached in-process.
 * `process.env` is read here (inside the call), never at module scope.
 */
export async function getIceConfig(): Promise<IceConfigDto> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  if (inflight) return inflight;

  const app = process.env["METERED_APP_NAME"];
  const key = process.env["METERED_SECRET_KEY"];
  if (!app || !key) {
    const fallback = stunOnly();
    cache = { value: fallback, expiresAt: now + 60_000 };
    return fallback;
  }

  inflight = (async () => {
    const value = await fetchMetered(app.trim(), key.trim());
    // Failed lookups get a short TTL so a transient Metered blip doesn't pin
    // the whole fleet to STUN-only for an hour.
    cache = { value, expiresAt: Date.now() + (value.hasTurn ? CACHE_TTL_MS : 60_000) };
    return value;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Host list for logging — never includes the credential. */
export function describeIce(cfg: IceConfigDto): string {
  return cfg.iceServers.map((s) => String(s.urls)).join(", ");
}
