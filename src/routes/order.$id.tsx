import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getOrderPublic } from "@/lib/orders.functions";
import { Footer } from "@/components/Footer";

type Invoice = {
  id: string;
  email: string;
  full_name: string;
  plan_code: string;
  amount_usd: number;
  coin: "BTC" | "USDT_ERC20" | "USDC_ERC20";
  amount_coin: number;
  price_locked_at: string;
  price_expires_at: string;
  receive_address: string | null;
  status: "pending" | "detected" | "paid" | "expired" | "refunded" | "cancelled";
  tx_hash: string | null;
  confirmations: number;
  access_link: string | null;
  created_at: string;
};

const COIN_LABEL: Record<Invoice["coin"], string> = {
  BTC: "Bitcoin (BTC)",
  USDT_ERC20: "Tether (USDT · ERC-20)",
  USDC_ERC20: "USD Coin (USDC · ERC-20)",
};

const CONF_TARGET: Record<Invoice["coin"], number> = {
  BTC: 2,
  USDT_ERC20: 12,
  USDC_ERC20: 12,
};

export const Route = createFileRoute("/order/$id")({
  component: InvoicePage,
  head: ({ params }) => ({
    meta: [
      { title: `Invoice ${params.id.slice(0, 8)} — ConnectLive` },
      { name: "description", content: "Complete your ConnectLive payment." },
      { property: "og:title", content: "ConnectLive invoice" },
      { property: "og:description", content: "Complete your ConnectLive payment." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function InvoicePage() {
  const { id } = Route.useParams();
  const loadOrder = useServerFn(getOrderPublic);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const row = await loadOrder({ data: { id } });
        if (alive) setInv(row as Invoice);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "Not found");
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, loadOrder]);

  if (err)
    return (
      <Shell>
        <p className="text-red-300">{err}</p>
      </Shell>
    );
  if (!inv)
    return (
      <Shell>
        <p className="text-white/60">Loading invoice…</p>
      </Shell>
    );

  const paid = inv.status === "paid";
  const detected = inv.status === "detected";
  const target = CONF_TARGET[inv.coin];
  const confPct = Math.min(100, Math.round(((inv.confirmations || 0) / target) * 100));
  const expiresAt = new Date(inv.price_expires_at);
  const expired = Date.now() > expiresAt.getTime() && !paid && !detected;

  const copyAddr = async () => {
    if (!inv.receive_address) return;
    try {
      await navigator.clipboard.writeText(inv.receive_address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const qrSrc = inv.receive_address
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(inv.receive_address)}`
    : null;

  return (
    <Shell>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="text-xs uppercase tracking-wider text-white/50">Amount due</div>
          <div className="mt-1 font-mono text-3xl">
            {inv.amount_coin}{" "}
            <span className="text-base text-white/60">{inv.coin.split("_")[0]}</span>
          </div>
          <div className="mt-1 text-xs text-white/50">
            ≈ ${Number(inv.amount_usd).toFixed(2)} USD · {COIN_LABEL[inv.coin]}
          </div>

          <div className="mt-6">
            <div className="text-xs uppercase tracking-wider text-white/50">
              Send to this address
            </div>
            {inv.receive_address ? (
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-black/40 p-2 font-mono text-xs">
                  {inv.receive_address}
                </code>
                <button
                  onClick={copyAddr}
                  className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            ) : (
              <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                Payment address is being provisioned. Refresh in a moment or contact support.
              </div>
            )}
            {qrSrc && (
              <img src={qrSrc} alt="Payment QR" className="mx-auto mt-4 rounded-lg bg-white p-2" />
            )}
          </div>

          {!paid && !detected && (
            <div className={`mt-4 text-xs ${expired ? "text-amber-300" : "text-white/50"}`}>
              {expired
                ? "Price lock expired — refresh to recalculate the amount."
                : `Price locked until ${expiresAt.toLocaleTimeString()}.`}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="text-xs uppercase tracking-wider text-white/50">Status</div>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                paid
                  ? "bg-green-400"
                  : detected
                    ? "bg-amber-400 animate-pulse"
                    : expired
                      ? "bg-red-400"
                      : "bg-white/40"
              }`}
            />
            <span className="text-lg font-medium capitalize">{inv.status}</span>
          </div>

          {(detected || paid) && (
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-xs text-white/60">
                <span>
                  {inv.confirmations} / {target} confirmations
                </span>
                <span>{confPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-[#4F7CFF] transition-all"
                  style={{ width: `${confPct}%` }}
                />
              </div>
              {inv.tx_hash && (
                <div className="mt-2 break-all text-[11px] text-white/50">
                  Tx: <code>{inv.tx_hash}</code>
                </div>
              )}
            </div>
          )}

          {paid && (
            <div className="mt-6 rounded-lg border border-green-500/40 bg-green-500/10 p-4">
              <div className="text-sm font-semibold text-green-200">Payment confirmed 🎉</div>
              {inv.access_link ? (
                <a
                  href={inv.access_link}
                  className="mt-3 inline-block rounded-lg bg-[#4F7CFF] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3E67E0]"
                >
                  Open your access link →
                </a>
              ) : (
                <p className="mt-2 text-xs text-green-100/80">
                  Your technician will email your access link shortly.
                </p>
              )}
            </div>
          )}

          <div className="mt-6 space-y-1 text-xs text-white/60">
            <div>
              <span className="text-white/40">Order ID:</span> <code>{inv.id}</code>
            </div>
            <div>
              <span className="text-white/40">Name:</span> {inv.full_name}
            </div>
            <div>
              <span className="text-white/40">Email:</span> {inv.email}
            </div>
            <div>
              <span className="text-white/40">Plan:</span> {inv.plan_code}
            </div>
          </div>
        </section>
      </div>

      <div className="mt-8 text-center text-xs text-white/50">
        <Link to="/" className="hover:text-white">
          ← Back to ConnectLive
        </Link>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#050B1F] text-white">
      <header className="border-b border-white/10 px-6 py-4">
        <Link to="/" className="flex items-center gap-2 text-sm text-white/70 hover:text-white">
          ← ConnectLive
        </Link>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-10">{children}</main>
      <Footer />
    </div>
  );
}
