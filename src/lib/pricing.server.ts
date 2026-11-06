/**
 * Pricing service: fetch USD→coin conversion rates.
 *
 * Cloudflare Workers egress is blocked (HTTP 403) by CoinGecko's free tier
 * without an API key, so we try a chain of edge-friendly providers and fall
 * use a short, bounded cache if every provider fails. Pricing is public data;
 * authorization and device state must never use this cache.
 */

type CoinKey = "BTC";

let cache: { ts: number; rates: Record<CoinKey, number> } | null = null;
let inFlight: Promise<Record<CoinKey, number>> | null = null;
let retryAfter = 0;
const TTL_MS = 60 * 1000;
const MAX_STALE_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 10 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const unavailable = () => new Error("Live pricing temporarily unavailable, please retry in a moment.");

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

/** Coinbase spot: one call per symbol, but reliable from edge. */
async function fromCoinbase(): Promise<Partial<Record<CoinKey, number>>> {
  const pairs: Array<[CoinKey, string]> = [
    ["BTC", "BTC-USD"],
  ];
  const out: Partial<Record<CoinKey, number>> = {};
  await Promise.all(
    pairs.map(async ([key, pair]) => {
      try {
        const r = await timedFetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
        if (!r.ok) return;
        const j = (await r.json()) as { data?: { amount?: string } };
        const amt = Number(j?.data?.amount);
        if (Number.isFinite(amt) && amt > 0) out[key] = amt;
      } catch {
        // ignore, next provider
      }
    }),
  );
  return out;
}

/** Kraken public ticker fallback. */
async function fromKraken(): Promise<Partial<Record<CoinKey, number>>> {
  try {
    const r = await timedFetch(
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    );
    if (!r.ok) return {};
    const j = (await r.json()) as { result?: Record<string, { c?: string[] }> };
    const result = j?.result ?? {};
    const pick = (needle: string): number | undefined => {
      const key = Object.keys(result).find((k) => k.toUpperCase().includes(needle));
      const amt = key ? Number(result[key]?.c?.[0]) : NaN;
      return Number.isFinite(amt) && amt > 0 ? amt : undefined;
    };
    const out: Partial<Record<CoinKey, number>> = {};
    const btc = pick("XBT") ?? pick("BTC");
    if (btc) out.BTC = btc;
    return out;
  } catch {
    return {};
  }
}

/** CoinGecko last-resort (often 403 from Workers, but try anyway). */
async function fromCoinGecko(): Promise<Partial<Record<CoinKey, number>>> {
  try {
    const r = await timedFetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    );
    if (!r.ok) return {};
    const j = (await r.json()) as Record<string, { usd?: number }>;
    const out: Partial<Record<CoinKey, number>> = {};
    if (j.bitcoin?.usd) out.BTC = j.bitcoin.usd;
    return out;
  } catch {
    return {};
  }
}

export async function getUsdToCoinRates(): Promise<Record<CoinKey, number>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.rates;
  if (inFlight) return inFlight;
  if (Date.now() < retryAfter) {
    if (cache && Date.now() - cache.ts <= MAX_STALE_MS) return cache.rates;
    throw unavailable();
  }
  // Single-flight per server process prevents simultaneous expired-cache
  // requests from each starting their own provider chain.
  inFlight = refreshRates().finally(() => { inFlight = null; });
  return inFlight;
}

async function refreshRates(): Promise<Record<CoinKey, number>> {
  const merged: Partial<Record<CoinKey, number>> = {};
  for (const provider of [fromCoinbase, fromKraken, fromCoinGecko]) {
    if (merged.BTC) break;
    try {
      const part = await provider();
      for (const k of Object.keys(part) as CoinKey[]) {
        const value = part[k];
        if (!merged[k] && value !== undefined && Number.isFinite(value) && value > 0) merged[k] = value;
      }
    } catch {
      // ignore, try next provider
    }
  }

  // No invented exchange rate when providers fail.
  if (!merged.BTC) {
    retryAfter = Date.now() + FAILURE_RETRY_MS;
    if (cache && Date.now() - cache.ts <= MAX_STALE_MS) {
      console.warn("[pricing] providers unavailable; using cached rates younger than five minutes");
      return cache.rates;
    }
    throw unavailable();
  }

  const rates: Record<CoinKey, number> = {
    BTC: merged.BTC,
  };
  retryAfter = 0;
  Object.freeze(rates);
  cache = { ts: Date.now(), rates };
  return rates;
}

/** How many coin units for a given USD amount. */
export function usdToCoin(usd: number, coin: CoinKey, rates: Record<CoinKey, number>): number {
  const rate = rates[coin];
  if (!rate) throw new Error(`No rate for ${coin}`);
  const amount = usd / rate;
  const decimals = 8;
  return Math.ceil(amount * 10 ** decimals) / 10 ** decimals;
}
