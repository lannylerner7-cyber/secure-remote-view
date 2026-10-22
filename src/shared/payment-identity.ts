export type PaymentCoin = "BTC" | "USDT_ERC20" | "USDC_ERC20";

/** Invoice reference, not a blockchain memo. Retains the complete UUID. */
export function orderReference(id: string): string {
  return `CL-${id.toUpperCase()}`;
}

/** Exact base-unit comparison; never use an epsilon for unique payment quotes. */
export function paymentUnits(value: string | number, coin: PaymentCoin): bigint {
  if (!["BTC", "USDT_ERC20", "USDC_ERC20"].includes(coin)) throw new Error("Unsupported coin");
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match || String(value).length > 100) throw new Error("Invalid amount");
  const decimals = coin === "BTC" ? 8 : 6;
  const exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 40) throw new Error("Invalid exponent");
  const fraction = match[2] ?? "";
  const digits = BigInt(match[1] + fraction);
  const shift = decimals + exponent - fraction.length;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  if (digits % divisor !== 0n) throw new Error("Amount exceeds currency precision");
  return digits / divisor;
}

export function exactPaymentAmount(a: string | number, b: string | number, coin: PaymentCoin): boolean {
  try {
    const amount = paymentUnits(a, coin);
    return amount > 0n && amount === paymentUnits(b, coin);
  } catch {
    return false;
  }
}
