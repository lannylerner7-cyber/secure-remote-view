/**
 * Standard Bitcoin receiving-wallet adapter and legacy invoice detection.
 * The filename is retained for existing reconciler/webhook imports. New
 * checkout uses a mainnet address, not a Coinbase account or custodial SDK.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeBitcoinAddress } from "@/shared/bitcoin";

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
  if (coin !== "BTC") throw new Error("New orders accept Bitcoin only.");
  const chain = "bitcoin";
  const { data, error } = await supabaseAdmin
    .from("admin_wallets")
    .select("id, cdp_wallet_id, addresses_issued")
    .eq("coin", coin)
    .eq("chain", chain)
    .maybeSingle();
  if (error) throw new Error("Could not read the receiving wallet.");
  if (!data?.cdp_wallet_id) return null;
  const address = normalizeBitcoinAddress(data.cdp_wallet_id);
  return address;
}

export type ChainTx = {
  txHash: string;
  amountCoin: number;
  confirmations: number;
  timestamp: number;
};

/**
 * Query the public blockchain for recent inbound transactions to `address`.
 * Uses a bounded public API request. An unavailable chain is NOT an empty
 * wallet: propagate failures so the reconciler cannot expire an unseen payment.
 */
export async function fetchInboundTxs(coin: CoinKey, address: string): Promise<ChainTx[]> {
  if (coin === "BTC") {
      const receivingAddress = normalizeBitcoinAddress(address);
      const [r, tipResponse] = await Promise.all([
        fetch(`https://blockstream.info/api/address/${encodeURIComponent(receivingAddress)}/txs`, { signal: AbortSignal.timeout(8000) }),
        fetch("https://blockstream.info/api/blocks/tip/height", { signal: AbortSignal.timeout(8000) }),
      ]);
      if (!r.ok || !tipResponse.ok) throw new Error("Bitcoin network lookup is unavailable.");
      const txs = (await r.json()) as Array<{
        txid: string;
        status: { confirmed: boolean; block_height?: number; block_time?: number };
        vout: Array<{ scriptpubkey_address?: string; value: number }>;
      }>;
      const tip = Number(await tipResponse.text());
      if (!Array.isArray(txs) || !Number.isSafeInteger(tip) || tip <= 0) {
        throw new Error("Bitcoin network lookup returned invalid data.");
      }
      return txs.slice(0, 25).map((t) => {
        if (!/^[a-f0-9]{64}$/i.test(t.txid) || !t.status || !Array.isArray(t.vout)) {
          throw new Error("Bitcoin transaction data is invalid.");
        }
        const value = t.vout
          .filter((o) => o.scriptpubkey_address === receivingAddress)
          .reduce((s, o) => s + o.value, 0);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bitcoin output amount is invalid.");
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
  // Historical ERC-20 invoices keep their authenticated webhook path.
  return [];
}
