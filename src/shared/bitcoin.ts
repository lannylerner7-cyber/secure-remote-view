import { Network, validate } from "bitcoin-address-validation";
import { paymentUnits } from "./payment-identity";

export const BITCOIN_CONFIRMATIONS = 2;

/** Validate checksum and network, not just a prefix or length. No private keys. */
export function isBitcoinAddress(address: string): boolean {
  try {
    return validate(address, Network.mainnet);
  } catch {
    return false;
  }
}

export function normalizeBitcoinAddress(input: string): string {
  const address = input.trim();
  if (!isBitcoinAddress(address)) {
    throw new Error("Enter a valid Bitcoin mainnet receiving address (1…, 3…, or bc1…).");
  }
  // Bech32 is case-insensitive, but mixed case is invalid and was rejected above.
  return /^bc1/i.test(address) ? address.toLowerCase() : address;
}

export function formatBitcoinAmount(amount: string | number): string {
  const sats = paymentUnits(amount, "BTC");
  if (sats <= 0n || sats > 2_100_000_000_000_000n) throw new Error("Invalid Bitcoin amount");
  return `${sats / 100_000_000n}.${(sats % 100_000_000n).toString().padStart(8, "0")}`;
}

/** BIP21: the invoice's snapshotted address and exact amount, never a new quote. */
export function bitcoinPaymentUri(address: string, amount?: string | number, reference?: string): string {
  const normalized = normalizeBitcoinAddress(address);
  const fields: string[] = [];
  if (amount !== undefined) fields.push(`amount=${formatBitcoinAmount(amount)}`);
  if (reference) fields.push(`label=${encodeURIComponent(reference)}`);
  return `bitcoin:${normalized}${fields.length ? `?${fields.join("&")}` : ""}`;
}

export type PaymentsHealth = {
  wallets: { BTC: boolean };
  wallet_issue: string | null;
  network: "bitcoin-mainnet";
  confirmations_required: number;
  cron_secret_configured: boolean;
  monitoring_note: string;
};
