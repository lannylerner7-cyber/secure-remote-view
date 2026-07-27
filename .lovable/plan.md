## Problem

Clicking **Continue to invoice** on `/order` calls the `createOrder` server fn, which calls `getUsdToCoinRates()` in `src/lib/pricing.server.ts`. That helper hits `api.coingecko.com` directly from Cloudflare Workers. CoinGecko's free public endpoint frequently returns **HTTP 403** to Cloudflare/edge egress IPs (they rate-limit/block datacenter ranges without an API key). The single-provider path has no fallback and no key, so every user gets `Pricing feed unavailable (403)`.

## Fix

Rewrite `src/lib/pricing.server.ts` to be resilient:

1. **Multi-provider chain** (try in order, first success wins):
   - **Coinbase** — `https://api.coinbase.com/v2/prices/{BTC,USDT,USDC}-USD/spot` (edge-friendly, no key, very reliable).
   - **Kraken** — `https://api.kraken.com/0/public/Ticker?pair=XBTUSD,USDTUSD,USDCUSD` (no key).
   - **CoinGecko** — kept as last resort with a real browser `User-Agent` header (403s are UA/IP driven; keeping it in the chain preserves current behavior when it works).
   - Assume `USDT_ERC20` / `USDC_ERC20` ≈ $1 if their spot lookup fails but BTC succeeds (stablecoins).

2. **Stale-cache safety net**: keep the existing 10-min in-memory cache, and if every provider fails but we still have a cached value, return it (log a warning) instead of throwing. Only throw when there is no cached rate at all.

3. **Timeouts**: wrap each `fetch` in an `AbortController` with a 3s timeout so one slow provider can't block the whole request.

4. **Clearer error**: when everything fails and no cache exists, throw a user-friendly message ("Live pricing temporarily unavailable, please retry in a moment.") instead of exposing the raw upstream status.

No schema changes, no other files touched. `usdToCoin` and the `CoinKey` type stay identical, so `orders.functions.ts` and the reconcile cron keep working unchanged.

## Verification

- Invoke `createOrder` via a test call and confirm it returns an invoice with a non-zero `amount_coin` for BTC.
- Force-fail the primary (temporarily point Coinbase URL at a bad host in a scratch check) and confirm Kraken fallback still produces a rate.
