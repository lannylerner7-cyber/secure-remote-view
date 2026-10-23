import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getOrderPublic } from "@/lib/orders.functions";
import { Check, Copy } from "lucide-react";
import { SiteShell } from "@/components/site/layout";
import { ActionButton, Badge, Button, Notice } from "@/components/site/ui";
import { orderReference } from "@/shared/payment-identity";

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
        <Notice
          tone="error"
          title="Invoice unavailable"
          action={
            <Button to="/license" variant="secondary">
              Look up a license
            </Button>
          }
        >
          {err}
        </Notice>
      </Shell>
    );
  if (!inv)
    return (
      <Shell>
        <div className="grid gap-6 md:grid-cols-2" aria-label="Loading invoice">
          <div className="cl-skeleton h-96" />
          <div className="cl-skeleton h-96" />
        </div>
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

  const stage = paid ? 4 : detected ? 3 : 2;

  return (
    <Shell>
      <ol className="mx-auto mb-10 grid max-w-3xl grid-cols-3 gap-3" aria-label="Payment progress">
        {[
          ["Invoice created", true],
          ["Payment detected", stage >= 3],
          ["Access delivered", stage >= 4],
        ].map(([label, done]) => (
          <li
            key={label as string}
            className="rounded-xl bg-white/5 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
          >
            <span className={`block size-2 rounded-full ${done ? "bg-cl-success" : "bg-white/25"}`} />
            <p className="mt-4 text-sm font-semibold">{label as string}</p>
            <p className="mt-2 font-mono text-[0.65rem] uppercase tracking-widest text-cl-faint">
              {done ? "Complete" : "Waiting"}
            </p>
          </li>
        ))}
      </ol>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="surface p-6 md:p-8">
          <p className="hairline-title">Amount due</p>
          <div className="tabular mt-3 break-all font-mono text-3xl font-semibold">
            {inv.amount_coin}{" "}
            <span className="text-base text-cl-muted">{inv.coin.split("_")[0]}</span>
          </div>
          <div className="mt-2 text-sm text-cl-muted">
            ≈ ${Number(inv.amount_usd).toFixed(2)} USD · {COIN_LABEL[inv.coin]}
          </div>
          <p className="mt-4 text-xs leading-5 text-cl-warning">
            Pay the exact crypto amount shown. Quotes may include a matching adjustment
            of up to {inv.coin === "BTC" ? "0.00000099 BTC" : `0.000099 ${inv.coin.split("_")[0]}`}.
            Do not round the amount or subtract network fees from it.
          </p>

          <div className="mt-7">
            <p className="field-label">Send to this address</p>
            {inv.receive_address ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-black/30 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <code className="min-w-0 flex-1 break-all font-mono text-xs text-cl-muted">
                  {inv.receive_address}
                </code>
                <ActionButton
                  className="!size-10 shrink-0 !p-0"
                  variant="secondary"
                  aria-label={copied ? "Address copied" : "Copy receiving address"}
                  onClick={copyAddr}
                  data-testid="button-copy-address"
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </ActionButton>
              </div>
            ) : (
              <div className="mt-3">
                <Notice tone="warning">
                  Payment address is being provisioned. Refresh in a moment or contact support.
                </Notice>
              </div>
            )}
            {qrSrc && (
              <img src={qrSrc} alt="Payment QR" className="mx-auto mt-5 rounded-lg bg-white p-2" />
            )}
          </div>

          {!paid && !detected && (
            <div className={`mt-5 text-xs ${expired ? "text-cl-warning" : "text-cl-faint"}`}>
              {expired
                ? "Price lock expired — refresh to recalculate the amount."
                : `Price locked until ${expiresAt.toLocaleTimeString()}.`}
            </div>
          )}
        </section>

        <section className="surface p-6 md:p-8">
          <p className="hairline-title">Status</p>
          <div className="mt-3 flex items-center gap-3">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                paid
                  ? "bg-cl-success"
                  : detected
                    ? "animate-pulse bg-cl-warning"
                    : expired
                      ? "bg-cl-danger"
                      : "bg-white/40"
              }`}
            />
            <span className="font-display text-2xl capitalize" data-testid="status-invoice">
              {inv.status}
            </span>
          </div>

          {(detected || paid) && (
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between font-mono text-xs text-cl-muted">
                <span>
                  {inv.confirmations} / {target} confirmations
                </span>
                <span>{confPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-cl-signal transition-all"
                  style={{ width: `${confPct}%` }}
                />
              </div>
              {inv.tx_hash && (
                <div className="mt-2 break-all text-[11px] text-cl-faint">
                  Tx: <code>{inv.tx_hash}</code>
                </div>
              )}
            </div>
          )}

          {paid && (
            <div className="mt-6">
              <Notice tone="success" title="Payment confirmed">
                {inv.access_link ? (
                  <a className="button button-primary mt-2" href={inv.access_link}>
                    <span className="relative z-10">Open your access link</span>
                  </a>
                ) : (
                  "Your technician will email your access link shortly."
                )}
              </Notice>
            </div>
          )}

          <div className="metal-line my-6" />
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="hairline-title">Order reference</dt>
              <dd className="mt-1 break-all font-mono">{orderReference(inv.id)}</dd>
              <p className="mt-1 text-xs text-cl-faint">
                Use this reference for tracking and support; it is not a required blockchain memo.
              </p>
            </div>
            <div className="flex justify-between gap-3"><dt className="text-cl-faint">Name</dt><dd className="text-right">{inv.full_name}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-cl-faint">Email</dt><dd className="break-all text-right">{inv.email}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-cl-faint">Plan</dt><dd className="text-right capitalize">{inv.plan_code}</dd></div>
          </dl>
        </section>
      </div>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button to="/license" variant="secondary">Look up a license</Button>
        <Button to="/" variant="ghost">Back to ConnectLive</Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <SiteShell>
      <section className="section-tight">
        <div className="container max-w-5xl">
          <div className="mx-auto mb-10 max-w-3xl text-center">
            <Badge live>Live payment tracker</Badge>
            <h1 className="display-lg balanced mt-7">Your invoice.</h1>
            <p className="body-lg mt-5">This page refreshes automatically every 10 seconds.</p>
          </div>
          {children}
        </div>
      </section>
    </SiteShell>
  );
}
