import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createOrderPublic, getActivePlansPublic } from "@/lib/orders.functions";
import { Footer } from "@/components/Footer";
import { Bitcoin, Building2, Coins, DollarSign, Mail, Phone, User } from "lucide-react";

type Plan = {
  code: string;
  name: string;
  description: string | null;
  amount_usd: number;
};

export const Route = createFileRoute("/order/")({
  component: OrderPage,
  head: () => ({
    meta: [
      { title: "Order a ConnectLive license" },
      {
        name: "description",
        content: "Buy a ConnectLive remote-support license with Bitcoin, USDT, or USDC.",
      },
      { property: "og:title", content: "Order a ConnectLive license" },
      {
        property: "og:description",
        content: "Pay in BTC, USDT, or USDC. Instant invoice, live payment tracking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function OrderPage() {
  const navigate = useNavigate();
  const loadPlans = useServerFn(getActivePlansPublic);
  const createOrder = useServerFn(createOrderPublic);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    phone: "",
    company: "",
    plan_code: "",
    coin: "BTC" as "BTC" | "USDT_ERC20" | "USDC_ERC20",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadPlans()
      .then((rows) => {
        const list = (rows as Plan[]) ?? [];
        setPlans(list);
        if (list[0]) setForm((f) => ({ ...f, plan_code: list[0].code }));
      })
      .catch(() => setPlans([]));
  }, [loadPlans]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const res = await createOrder({
        data: {
          full_name: form.full_name,
          email: form.email,
          phone: form.phone || null,
          company: form.company || null,
          plan_code: form.plan_code,
          coin: form.coin,
        },
      });
      navigate({ to: "/order/$id", params: { id: (res as { id: string }).id } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create order");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050B1F] text-white">
      <header className="border-b border-white/10 px-6 py-4">
        <Link to="/" className="flex items-center gap-2 text-sm text-white/70 hover:text-white">
          ← ConnectLive
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-3xl font-semibold">Buy a ConnectLive license</h1>
        <p className="mt-2 text-sm text-white/60">
          Pick a plan and pay in Bitcoin, USDT, or USDC. You'll get an invoice with a live payment
          tracker.
        </p>

        <form onSubmit={submit} className="mt-8 grid gap-6 md:grid-cols-2">
          <label className="md:col-span-2">
            <div className="mb-1 text-xs uppercase tracking-wider text-white/50">Plan</div>
            <div className="grid gap-2">
              {plans.map((p) => (
                <label
                  key={p.code}
                  className={`flex cursor-pointer items-start justify-between rounded-lg border p-3 text-sm ${
                    form.plan_code === p.code
                      ? "border-[#4F7CFF] bg-[#4F7CFF]/10"
                      : "border-white/10 bg-white/5 hover:border-white/25"
                  }`}
                >
                  <div>
                    <div className="font-medium">{p.name}</div>
                    {p.description && (
                      <div className="mt-0.5 text-xs text-white/50">{p.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="font-mono text-base">${Number(p.amount_usd).toFixed(0)}</div>
                      <div className="text-[10px] uppercase tracking-wider text-white/40">
                        per month
                      </div>
                    </div>
                    <input
                      type="radio"
                      name="plan"
                      value={p.code}
                      checked={form.plan_code === p.code}
                      onChange={() => setForm({ ...form, plan_code: p.code })}
                    />
                  </div>
                </label>
              ))}
              {plans.length === 0 && (
                <div className="rounded border border-white/10 bg-white/5 p-3 text-xs text-white/50">
                  No active plans configured yet.
                </div>
              )}
              <Link
                to="/contact"
                className="flex items-start justify-between rounded-lg border border-dashed border-white/20 bg-white/[0.03] p-3 text-sm hover:border-[#4F7CFF]/60"
              >
                <div>
                  <div className="font-medium">Custom — Unlimited devices</div>
                  <div className="mt-0.5 text-xs text-white/50">
                    Enterprise fleets — manual order handled by our team.
                  </div>
                </div>
                <div className="text-xs font-semibold text-[#4F7CFF]">Contact us →</div>
              </Link>
            </div>
          </label>

          <Field
            label="Full name"
            required
            icon={<User className="h-4 w-4" />}
            value={form.full_name}
            onChange={(v) => setForm({ ...form, full_name: v })}
          />
          <Field
            label="Email"
            required
            type="email"
            icon={<Mail className="h-4 w-4" />}
            value={form.email}
            onChange={(v) => setForm({ ...form, email: v })}
          />
          <Field
            label="Phone (optional)"
            icon={<Phone className="h-4 w-4" />}
            value={form.phone}
            onChange={(v) => setForm({ ...form, phone: v })}
          />
          <Field
            label="Company (optional)"
            icon={<Building2 className="h-4 w-4" />}
            value={form.company}
            onChange={(v) => setForm({ ...form, company: v })}
          />

          <label className="md:col-span-2">
            <div className="mb-1 text-xs uppercase tracking-wider text-white/50">Pay with</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  { k: "BTC", label: "Bitcoin", sub: "BTC", Icon: Bitcoin },
                  { k: "USDT_ERC20", label: "Tether", sub: "USDT · ERC-20", Icon: Coins },
                  { k: "USDC_ERC20", label: "USD Coin", sub: "USDC · ERC-20", Icon: DollarSign },
                ] as const
              ).map((c) => (
                <button
                  type="button"
                  key={c.k}
                  onClick={() => setForm({ ...form, coin: c.k })}
                  className={`rounded-lg border px-3 py-3 text-left text-sm ${
                    form.coin === c.k
                      ? "border-[#4F7CFF] bg-[#4F7CFF]/10"
                      : "border-white/10 bg-white/5 hover:border-white/25"
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    <c.Icon className="h-4 w-4 shrink-0 text-[#F7931A]" />
                    {c.label}
                  </div>
                  <div className="mt-0.5 text-[11px] text-white/50">{c.sub}</div>
                </button>
              ))}
            </div>
          </label>

          {err && (
            <div className="md:col-span-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
              {err}
            </div>
          )}

          <div className="md:col-span-2 flex flex-col items-start gap-3 text-xs text-white/50 sm:flex-row sm:items-center sm:justify-between">
            <span>Price is locked for 15 minutes after you create the invoice.</span>
            <button
              type="submit"
              disabled={submitting || !form.plan_code}
              className="w-full rounded-lg bg-[#4F7CFF] px-5 py-3 sm:w-auto text-sm font-semibold text-white transition hover:bg-[#3E67E0] disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Continue to invoice →"}
            </button>
          </div>
        </form>
      </main>

      <Footer />
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  icon,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  icon?: React.ReactNode;
  type?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs uppercase tracking-wider text-white/50">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 focus-within:border-[#4F7CFF]">
        {icon && <span className="shrink-0 text-white/40">{icon}</span>}
        <input
          type={type}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full min-w-0 bg-transparent py-2.5 text-sm text-white outline-none"
        />
      </div>
    </label>
  );
}
