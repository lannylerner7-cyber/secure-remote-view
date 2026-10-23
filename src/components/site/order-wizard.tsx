import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Bitcoin,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Coins,
  Gift,
  LoaderCircle,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { SiteLink, useQueryParam } from "./adapter";
import { PAYMENT_NETWORKS, WAS_PRICE, type CoinId } from "./data";
import { ActionButton, Badge, Button, Notice, TextField } from "./ui";

export type OrderPlan = {
  code: string;
  name: string;
  description: string | null;
  amount_usd: number;
};

export type OrderInput = {
  full_name: string;
  email: string;
  phone: string | null;
  company: string | null;
  plan_code: string;
  coin: CoinId;
};

const COIN_ICON = { BTC: Bitcoin, USDT_ERC20: Coins, USDC_ERC20: CircleDollarSign } as const;
const COIN_TINT = {
  BTC: "text-[#F7931A]",
  USDT_ERC20: "text-[#26A17B]",
  USDC_ERC20: "text-[#2775CA]",
} as const;

const STEP_LABELS = ["Plan", "Contact", "Payment", "Invoice"];

/**
 * Figma checkout layout driving the real order contract.
 *
 * `onCreate` creates the real order (production) and navigates to the live
 * invoice. When it is omitted (preview), the final step explains that checkout
 * is not connected instead of faking an invoice.
 */
export function OrderWizard({
  plans,
  plansError,
  onRetryPlans,
  onCreate,
}: {
  plans: OrderPlan[] | null;
  plansError?: string | null;
  onRetryPlans?: () => void;
  onCreate?: (input: OrderInput) => Promise<void>;
}) {
  const requestedPlan = useQueryParam("plan");
  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState("");
  const [coin, setCoin] = useState<CoinId>("BTC");
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", company: "" });
  const [errors, setErrors] = useState<{ full_name?: string; email?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewBlocked, setPreviewBlocked] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (!plans || plans.length === 0) return;
    setSelected((current) => {
      if (current && plans.some((p) => p.code === current)) return current;
      const match = plans.find((p) => p.code === requestedPlan);
      return (match ?? plans[0]).code;
    });
  }, [plans, requestedPlan]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const plan = plans?.find((p) => p.code === selected) ?? null;
  const price = plan ? Number(plan.amount_usd) : null;
  const network = PAYMENT_NETWORKS.find((n) => n.id === coin);

  const update = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const validate = () => {
    const next: typeof errors = {};
    if (form.full_name.trim().length < 2) next.full_name = "Enter your full name (at least 2 characters).";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) next.email = "Enter a valid email address.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const nextStep = () => {
    if (step === 1 && !plan) return;
    if (step === 2 && !validate()) return;
    setStep((value) => Math.min(3, value + 1));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step < 3) {
      nextStep();
      return;
    }
    if (!plan || submitting) return;
    if (!validate()) {
      setStep(2);
      return;
    }
    setErr(null);
    if (!accepted) {
      setErr("Please accept the Terms of Service and Refund Policy before continuing.");
      return;
    }
    if (!onCreate) {
      setPreviewBlocked(true);
      return;
    }
    setSubmitting(true);
    try {
      await onCreate({
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        phone: form.phone || null,
        company: form.company || null,
        plan_code: plan.code,
        coin,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create order");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="section-tight">
      <div className="container">
        <div className="mx-auto max-w-4xl text-center">
          <Badge>Crypto checkout · BTC · USDT · USDC</Badge>
          <h1 ref={headingRef} tabIndex={-1} className="display-lg balanced mt-7 outline-none">
            Buy a ConnectLive license.
          </h1>
          <p className="body-lg pretty mx-auto mt-5 max-w-2xl">
            Choose a device plan, add the delivery contact, and select Bitcoin, USDT, or USDC.
            You'll get an invoice with a live payment tracker.
          </p>
        </div>

        <div className="mx-auto mt-9 flex max-w-2xl flex-wrap items-center justify-center gap-2 text-center">
          <Gift size={16} className="text-cl-success" aria-hidden="true" />
          <p className="font-mono text-xs uppercase tracking-[0.12em] text-cl-success">
            Promo applied · $250→$150 · $570→$310 · $840→$560
          </p>
        </div>

        <ol className="mx-auto mt-10 flex max-w-3xl items-center" aria-label="Checkout progress">
          {STEP_LABELS.map((label, index) => {
            const item = index + 1;
            return (
              <li className="flex flex-1 items-center last:flex-none" key={label}>
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-full border font-mono text-xs transition ${
                    step >= item
                      ? "border-cl-signal bg-cl-signal text-cl-canvas"
                      : "border-white/15 text-cl-faint"
                  }`}
                  aria-current={step === item ? "step" : undefined}
                  title={label}
                >
                  {step > item ? <Check size={14} aria-hidden="true" /> : item}
                  <span className="sr-only">{label}</span>
                </span>
                {index < STEP_LABELS.length - 1 && (
                  <span className={`h-px w-full ${step > item ? "bg-cl-signal" : "bg-white/10"}`} />
                )}
              </li>
            );
          })}
        </ol>

        <div className="mx-auto mt-12 grid max-w-5xl gap-6 lg:grid-cols-[1fr_19rem]">
          <form className="surface p-6 md:p-8" onSubmit={submit} noValidate>
            {step === 1 && (
              <div key="s1" className="cl-pop">
                <p className="hairline-title">01 / Select a plan</p>
                <div className="mt-7 grid gap-3">
                  {plans === null && !plansError && (
                    <div className="grid gap-3" aria-label="Loading plans">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="cl-skeleton h-[5.5rem]" />
                      ))}
                    </div>
                  )}
                  {plansError && (
                    <Notice
                      tone="error"
                      title="Plans could not be loaded"
                      action={
                        onRetryPlans && (
                          <ActionButton variant="secondary" onClick={onRetryPlans}>
                            <RefreshCw size={15} aria-hidden="true" /> Try again
                          </ActionButton>
                        )
                      }
                    >
                      {plansError}
                    </Notice>
                  )}
                  {plans && plans.length === 0 && (
                    <Notice tone="warning" title="No active plans configured yet">
                      Contact the team and we will set up your order manually.
                    </Notice>
                  )}
                  {plans?.map((item) => (
                    <label
                      className={`flex cursor-pointer items-start justify-between gap-4 rounded-xl border p-5 transition-[border-color,background-color] ${
                        selected === item.code
                          ? "border-cl-signal bg-cl-signal/5"
                          : "border-white/10 hover:border-white/25"
                      }`}
                      key={item.code}
                      data-testid={`radio-plan-${item.code}`}
                    >
                      <span>
                        <span className="block font-display text-xl">{item.name}</span>
                        {item.description && (
                          <span className="mt-2 block text-sm text-cl-muted">{item.description}</span>
                        )}
                      </span>
                      <span className="flex items-center gap-4">
                        <span className="text-right">
                          <span className="flex items-baseline justify-end gap-2">
                            {WAS_PRICE[item.code] && (
                              <span className="font-mono text-xs text-cl-faint line-through">
                                ${WAS_PRICE[item.code]}
                              </span>
                            )}
                            <span className="tabular font-mono text-lg">
                              ${Number(item.amount_usd).toFixed(0)}
                            </span>
                          </span>
                          <span className="block font-mono text-[0.6rem] uppercase tracking-widest text-cl-faint">
                            per month
                          </span>
                        </span>
                        <input
                          type="radio"
                          name="plan"
                          value={item.code}
                          checked={selected === item.code}
                          onChange={() => setSelected(item.code)}
                          className="size-4 accent-[#6ea8ff]"
                        />
                      </span>
                    </label>
                  ))}
                </div>
                <div className="mt-5 text-right">
                  <Button to="/contact" variant="ghost">
                    Custom · unlimited devices — contact us
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div key="s2" className="cl-pop">
                <p className="hairline-title">02 / Delivery contact</p>
                <div className="mt-7 grid gap-5 md:grid-cols-2">
                  <TextField
                    id="order-name"
                    name="name"
                    label="Full name"
                    autoComplete="name"
                    required
                    value={form.full_name}
                    onChange={(e) => update("full_name", e.target.value)}
                    error={errors.full_name}
                    placeholder="Alex Morgan"
                    data-testid="input-order-name"
                  />
                  <TextField
                    id="order-email"
                    name="email"
                    label="Email"
                    type="email"
                    autoComplete="email"
                    required
                    value={form.email}
                    onChange={(e) => update("email", e.target.value)}
                    error={errors.email}
                    placeholder="alex@company.com"
                    data-testid="input-order-email"
                  />
                  <TextField
                    id="order-phone"
                    name="phone"
                    label="Phone (optional)"
                    type="tel"
                    autoComplete="tel"
                    value={form.phone}
                    onChange={(e) => update("phone", e.target.value)}
                    placeholder="+1 555 0142"
                    data-testid="input-order-phone"
                  />
                  <TextField
                    id="order-company"
                    name="organization"
                    label="Company (optional)"
                    autoComplete="organization"
                    value={form.company}
                    onChange={(e) => update("company", e.target.value)}
                    placeholder="Northstar Systems"
                    data-testid="input-order-company"
                  />
                </div>
                <div className="mt-7 flex gap-4 rounded-xl bg-white/5 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                  <PlayCircle className="mt-1 shrink-0 text-cl-signal-bright" size={20} aria-hidden="true" />
                  <div>
                    <p className="font-display text-lg">Video setup guides come with your order</p>
                    <p className="mt-2 text-sm leading-7 text-cl-muted">
                      Once your order completes we email the full delivery pack — agent installer,
                      admin console installer, your Meeting ID and sign-in details — together with
                      step-by-step video setup guides covering installation, device enrollment, and
                      your first live session. Delivery normally lands within 24 hours (48 at the
                      outside) on business days; please check your spam folder and mark our address
                      as safe.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div key="s3" className="cl-pop">
                <p className="hairline-title">03 / Choose payment network</p>
                <div className="mt-7 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Pay with">
                  {PAYMENT_NETWORKS.map((option) => {
                    const Icon = COIN_ICON[option.id];
                    const active = coin === option.id;
                    return (
                      <ActionButton
                        key={option.id}
                        role="radio"
                        aria-checked={active}
                        className={`!h-auto !justify-start !rounded-xl !p-5 text-left ${
                          active ? "!bg-cl-signal/10 shadow-[0_0_0_1px_var(--signal)]" : ""
                        }`}
                        variant="secondary"
                        onClick={() => setCoin(option.id)}
                        data-testid={`button-coin-${option.id}`}
                      >
                        <Icon size={19} className={COIN_TINT[option.id]} aria-hidden="true" />
                        <span>
                          <span className="block text-sm">{option.name}</span>
                          <span className="mt-1 block text-xs font-normal text-cl-faint">
                            {option.network}
                          </span>
                        </span>
                      </ActionButton>
                    );
                  })}
                </div>
                <div className="mt-7 grid gap-3">
                  <ReviewRow label="Contact" value={`${form.full_name} · ${form.email}`} />
                  <label className="mt-6 flex items-start gap-3 text-sm leading-6 text-cl-muted">
                    <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)}
                      className="mt-1 size-4 shrink-0 accent-blue-300" data-testid="checkbox-order-terms" />
                    <span>I agree to the <SiteLink href="/terms" target="_blank" rel="noopener noreferrer" className="underline">Terms of Service</SiteLink> and <SiteLink href="/refund" target="_blank" rel="noopener noreferrer" className="underline">Refund Policy</SiteLink>.</span>
                  </label>
                  <ReviewRow
                    label="Plan"
                    value={plan ? `${plan.name} · $${Number(plan.amount_usd).toFixed(0)}/month` : "—"}
                  />
                  <ReviewRow label="Payment" value={network?.network ?? coin} />
                </div>
                <p className="mt-6 text-xs leading-5 text-cl-faint">
                  Price is locked for 15 minutes after you create the invoice. The invoice shows the
                  exact amount and receiving address, then tracks network confirmations live.
                </p>
                {err && (
                  <div className="mt-6">
                    <Notice tone="error" title="Order not created">
                      {err}
                    </Notice>
                  </div>
                )}
                {previewBlocked && (
                  <div className="mt-6">
                    <Notice tone="warning" title="Checkout is not connected in this preview">
                      This is a static preview of the public website. No order was created, no
                      invoice or payment address was issued, and none of your details were sent.
                      Use the live ConnectLive site to buy a license.
                    </Notice>
                  </div>
                )}
              </div>
            )}

            <div className="mt-9 flex flex-col-reverse justify-between gap-3 border-t border-white/10 pt-6 sm:flex-row">
              {step > 1 ? (
                <ActionButton
                  variant="ghost"
                  onClick={() => {
                    setPreviewBlocked(false);
                    setStep((value) => value - 1);
                  }}
                  disabled={submitting}
                  data-testid="button-order-back"
                >
                  <ChevronLeft size={16} aria-hidden="true" /> Back
                </ActionButton>
              ) : (
                <span />
              )}
              <ActionButton
                type="submit"
                disabled={submitting || !plan}
                data-testid={step === 3 ? "button-order-create" : "button-order-continue"}
              >
                {step === 3 ? (
                  submitting ? (
                    <>
                      <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> Creating
                      invoice
                    </>
                  ) : (
                    <>
                      Continue to invoice <ChevronRight size={16} aria-hidden="true" />
                    </>
                  )
                ) : (
                  <>
                    Continue <ChevronRight size={16} aria-hidden="true" />
                  </>
                )}
              </ActionButton>
            </div>
          </form>

          <aside className="surface h-fit p-6 lg:sticky lg:top-28">
            <div className="flex items-center justify-between">
              <p className="hairline-title">Order summary</p>
              <ShieldCheck size={17} className="text-cl-success" aria-hidden="true" />
            </div>
            {plan ? (
              <>
                <h2 className="mt-6 font-display text-2xl">{plan.name}</h2>
                {plan.description && <p className="mt-2 text-sm text-cl-muted">{plan.description}</p>}
                <div className="metal-line my-6" />
                <div className="flex items-end justify-between">
                  <span className="text-sm text-cl-muted">Monthly total</span>
                  <span className="flex items-baseline gap-2">
                    {WAS_PRICE[plan.code] && (
                      <span className="font-mono text-xs text-cl-faint line-through">
                        ${WAS_PRICE[plan.code]}
                      </span>
                    )}
                    <span className="tabular font-display text-3xl">${price?.toFixed(0)}</span>
                  </span>
                </div>
                <p className="mt-2 text-right text-xs text-cl-faint">
                  price locked for 15 minutes on the invoice
                </p>
              </>
            ) : (
              <div className="mt-6 grid gap-3" aria-hidden="true">
                <div className="cl-skeleton h-7 w-2/3" />
                <div className="cl-skeleton h-4 w-full" />
                <div className="cl-skeleton h-9 w-1/2 justify-self-end" />
              </div>
            )}
            <div className="mt-7 rounded-xl bg-white/5 p-4 text-xs leading-5 text-cl-faint shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              Paying with {network?.name ?? "crypto"}. Your invoice page tracks the payment until
              network confirmations complete, then your access details are delivered by email.
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] sm:flex-row sm:items-center sm:justify-between">
      <span className="hairline-title">{label}</span>
      <span className="break-all text-sm">{value}</span>
    </div>
  );
}
