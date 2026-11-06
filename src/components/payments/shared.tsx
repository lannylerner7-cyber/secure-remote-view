import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

export type OrderRow = {
  id: string;
  email: string;
  full_name: string;
  plan_code: string;
  amount_usd: number;
  coin: string;
  amount_coin: number;
  status: string;
  tx_hash: string | null;
  confirmations: number;
  access_link: string | null;
  created_at: string;
};

export type Totals = {
  total_deposited_usd: number;
  total_pending_usd: number;
  total_failed_usd: number;
  count_paid: number;
  count_pending: number;
  count_failed: number;
  by_coin: Record<string, { paid: number; pending: number }>;
};

export type WalletRow = {
  id: string;
  coin: string;
  chain: string;
  cdp_wallet_id: string;
  addresses_issued: number;
  updated_at: string;
};

export const MANUAL_PAYABLE = ["pending", "detected", "expired"];

export function errMsg(e: unknown, fallback = "Request failed") {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const usd = (n: number) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const when = (s: string) =>
  new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/* Neutral, high-contrast tokens (stone scale; no brand hue). */
export const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1c1917] disabled:cursor-not-allowed disabled:opacity-50";
export const btnPrimary = `${btn} border-[#1c1917] bg-[#1c1917] text-[#fafaf9] hover:bg-[#3a3632]`;
export const btnSecondary = `${btn} border-[#d6d3d1] bg-[#fdfcfb] text-[#292524] hover:bg-[#f0eeeb]`;
export const btnDanger = `${btn} border-[#9f1d1d] bg-[#9f1d1d] text-[#fef2f2] hover:bg-[#7f1616]`;
export const input =
  "w-full rounded-md border border-[#d6d3d1] bg-[#fdfcfb] px-2.5 py-1.5 text-sm text-[#1c1917] placeholder:text-[#8a837c] focus:border-[#57534e] focus:outline-none focus:ring-2 focus:ring-[#a8a29e]/40 aria-[invalid=true]:border-[#b42318]";
export const panel = "rounded-lg border border-[#e2dfdb] bg-[#fdfcfb]";

const TONE = {
  info: { cls: "border-[#d6d3d1] bg-[#f5f4f2] text-[#292524]", Icon: Info },
  ok: { cls: "border-[#b9d3c0] bg-[#f1f7f2] text-[#1d4a2c]", Icon: CheckCircle2 },
  warn: { cls: "border-[#e2cfa3] bg-[#fbf6ea] text-[#5c4210]", Icon: AlertTriangle },
  error: { cls: "border-[#e6b8b3] bg-[#fcf1f0] text-[#7a1d14]", Icon: XCircle },
} as const;

export function Notice({
  tone,
  children,
  action,
  testId,
}: {
  tone: keyof typeof TONE;
  children: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  const { cls, Icon } = TONE[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs leading-relaxed ${cls}`}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

const PILL: Record<string, string> = {
  pending: "border-[#d6d3d1] bg-[#f5f4f2] text-[#44403c]",
  detected: "border-[#e2cfa3] bg-[#fbf6ea] text-[#5c4210]",
  paid: "border-[#b9d3c0] bg-[#f1f7f2] text-[#1d4a2c]",
  expired: "border-[#e6b8b3] bg-[#fcf1f0] text-[#7a1d14]",
  refunded: "border-[#c9c6d6] bg-[#f4f3f8] text-[#3b3755]",
  cancelled: "border-[#e2dfdb] bg-transparent text-[#6b645d]",
};

export function StatusPill({ s }: { s: string }) {
  return (
    <span
      className={`inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${PILL[s] ?? PILL.pending}`}
    >
      {s}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-[#ebe8e4] ${className}`} />;
}
