/**
 * Pricing service: fetch USD→coin conversion rates.
 * Uses CoinGecko's free/public endpoint (no key required, rate-limited).
 * Cached in-memory per handler cold start (10 min TTL).
 *
 * When CoinGecko is down we throw so the order fn can surface a clear error
 * rather than pricing the invoice with stale data.
 */

type CoinKey = "BTC" | "USDT_ERC20" | "USDC_ERC20";

const GECKO_ID: Record<CoinKey, string> = {
  BTC: "bitcoin",
  USDT_ERC20: "tether",
  USDC_ERC20: "usd-coin",
};

let cache: { ts: number; rates: Record<CoinKey, number> } | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function getUsdToCoinRates(): Promise<Record<CoinKey, number>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.rates;
  const ids = Object.values(GECKO_ID).join(",");
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Pricing feed unavailable (${res.status})`);
  const j = (await res.json()) as Record<string, { usd: number }>;
  const rates: Record<CoinKey, number> = {
    BTC: j[GECKO_ID.BTC]?.usd ?? 0,
    USDT_ERC20: j[GECKO_ID.USDT_ERC20]?.usd ?? 1,
    USDC_ERC20: j[GECKO_ID.USDC_ERC20]?.usd ?? 1,
  };
  if (!rates.BTC) throw new Error("Pricing feed returned no BTC rate");
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
