/**
 * Coinbase CDP wallet adapter (v1: HTTP-only shim).
 *
 * v1 uses the admin_wallets row per coin as the "wallet" and returns its
 * configured receive address for every order of that coin. This works
 * without the CDP SDK. When the operator adds CDP_API_KEY_ID /
 * CDP_API_KEY_SECRET secrets and a real CDP wallet, this file is the
 * single place we swap in per-order address derivation.
 *
 * Detection also lives here so the reconciler stays coin-agnostic.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { validateCdpConfig } from "./cdp-config.server";

let cdpWarnedOnce = false;

export type CoinKey = "BTC" | "USDT_ERC20" | "USDC_ERC20";

export type WalletRow = {
  id: string;
  coin: string;
  chain: string;
  cdp_wallet_id: string; // v1: holds the base receive address
  xpub: string | null;
  addresses_issued: number;
};

/**
 * Return a receive address for a new order.
 * v1: reuses the admin_wallets base address. v2 (with CDP SDK): derives a
 * fresh BIP32 / EVM address per order.
 */
export async function issueReceiveAddress(coin: CoinKey): Promise<string | null> {
  // Preflight: validate CDP config shape before any future SDK path.
  // v1 shim still falls through to admin_wallets, so an invalid/missing
  // config is a warning, not a hard failure.
  const check = validateCdpConfig();
  if (!check.ok && !cdpWarnedOnce) {
    console.warn(`[cdp] config not ready: ${check.reason} — using admin_wallets shim`);
    cdpWarnedOnce = true;
  }

  const chain = coin === "BTC" ? "bitcoin" : "ethereum";
  const { data } = await supabaseAdmin
    .from("admin_wallets")
    .select("id, cdp_wallet_id, addresses_issued")
    .eq("coin", coin)
    .eq("chain", chain)
    .maybeSingle();
  if (!data?.cdp_wallet_id) return null;
  await supabaseAdmin
    .from("admin_wallets")
    .update({ addresses_issued: (data.addresses_issued ?? 0) + 1 })
    .eq("id", data.id);
  return data.cdp_wallet_id;
}

export type ChainTx = {
  txHash: string;
  amountCoin: number;
  confirmations: number;
  timestamp: number;
};

/**
 * Query the public blockchain for recent inbound transactions to `address`.
 * Uses free public APIs; if the API errors we return an empty list so the
 * reconciler tolerates transient failures.
 */
export async function fetchInboundTxs(coin: CoinKey, address: string): Promise<ChainTx[]> {
  try {
    if (coin === "BTC") {
      const r = await fetch(`https://blockstream.info/api/address/${address}/txs`);
      if (!r.ok) return [];
      const txs = (await r.json()) as Array<{
        txid: string;
        status: { confirmed: boolean; block_height?: number; block_time?: number };
        vout: Array<{ scriptpubkey_address?: string; value: number }>;
      }>;
      const tip = await fetch("https://blockstream.info/api/blocks/tip/height")
        .then((x) => x.text())
        .then((t) => Number(t))
        .catch(() => 0);
      return txs.slice(0, 25).map((t) => {
        const value = t.vout
          .filter((o) => o.scriptpubkey_address === address)
          .reduce((s, o) => s + o.value, 0);
        const confs = t.status.confirmed && t.status.block_height && tip
          ? Math.max(0, tip - t.status.block_height + 1)
          : 0;
        return {
          txHash: t.txid,
          amountCoin: value / 1e8,
          confirmations: confs,
          timestamp: (t.status.block_time ?? Math.floor(Date.now() / 1000)) * 1000,
        };
      });
    }
    // ERC-20 USDT/USDC: needs an Etherscan-family API key for reliable data.
    // v1: return empty so the reconciler falls back to CDP webhook events.
    return [];
  } catch {
    return [];
  }
}
