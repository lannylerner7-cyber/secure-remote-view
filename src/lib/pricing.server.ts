/**
 * Pricing service: fetch USD→coin conversion rates.
 *
 * Cloudflare Workers egress is blocked (HTTP 403) by CoinGecko's free tier
 * without an API key, so we try a chain of edge-friendly providers and fall
 * back to the last cached value if every provider fails.
 */

type CoinKey = "BTC" | "USDT_ERC20" | "USDC_ERC20";

let cache: { ts: number; rates: Record<CoinKey, number> } | null = null;
const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

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
    ["USDT_ERC20", "USDT-USD"],
    ["USDC_ERC20", "USDC-USD"],
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
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,USDTZUSD,USDCUSD",
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
    const usdt = pick("USDT");
    const usdc = pick("USDC");
    if (btc) out.BTC = btc;
    if (usdt) out.USDT_ERC20 = usdt;
    if (usdc) out.USDC_ERC20 = usdc;
    return out;
  } catch {
    return {};
  }
}

/** CoinGecko last-resort (often 403 from Workers, but try anyway). */
async function fromCoinGecko(): Promise<Partial<Record<CoinKey, number>>> {
  try {
    const r = await timedFetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether,usd-coin&vs_currencies=usd",
    );
    if (!r.ok) return {};
    const j = (await r.json()) as Record<string, { usd?: number }>;
    const out: Partial<Record<CoinKey, number>> = {};
    if (j.bitcoin?.usd) out.BTC = j.bitcoin.usd;
    if (j.tether?.usd) out.USDT_ERC20 = j.tether.usd;
    if (j["usd-coin"]?.usd) out.USDC_ERC20 = j["usd-coin"].usd;
    return out;
  } catch {
    return {};
  }
}

export async function getUsdToCoinRates(): Promise<Record<CoinKey, number>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.rates;

  const merged: Partial<Record<CoinKey, number>> = {};
  for (const provider of [fromCoinbase, fromKraken, fromCoinGecko]) {
    if (merged.BTC && merged.USDT_ERC20 && merged.USDC_ERC20) break;
    try {
      const part = await provider();
      for (const k of Object.keys(part) as CoinKey[]) {
        if (!merged[k]) merged[k] = part[k];
      }
    } catch {
      // ignore, try next provider
    }
  }

  // BTC is the only rate we can't safely default. Stablecoins peg to $1.
  if (!merged.BTC) {
    if (cache) {
      console.warn("[pricing] all providers failed; serving stale cached rates");
      return cache.rates;
    }
    throw new Error("Live pricing temporarily unavailable, please retry in a moment.");
  }

  const rates: Record<CoinKey, number> = {
    BTC: merged.BTC,
    USDT_ERC20: merged.USDT_ERC20 ?? 1,
    USDC_ERC20: merged.USDC_ERC20 ?? 1,
  };
  cache = { ts: Date.now(), rates };
  return rates;
}

/** How many coin units for a given USD amount. */
export function usdToCoin(usd: number, coin: CoinKey, rates: Record<CoinKey, number>): number {
  const rate = rates[coin];
  if (!rate) throw new Error(`No rate for ${coin}`);
  const amount = usd / rate;
  // BTC: 8 decimals, USDT/USDC: 6 decimals on-chain, we round to their native precision.
  const decimals = coin === "BTC" ? 8 : 6;
  return Math.ceil(amount * 10 ** decimals) / 10 ** decimals;
}
