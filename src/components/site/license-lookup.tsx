import { useState, type FormEvent } from "react";
import { CircleCheck, CircleDashed, LoaderCircle, PackageCheck, Search } from "lucide-react";
import { SiteLink, useGo } from "./adapter";
import { ActionButton, Badge, Button, Notice, TextField } from "./ui";

export type LicenseRow = {
  id: string;
  plan_code: string;
  amount_usd: number;
  access_link: string | null;
  created_at: string;
  status: string;
};

/**
 * Figma license page wired to the real lookup contract. When `onLookup` is
 * omitted (preview) submitting explains that lookup is not connected.
 */
export function LicenseLookup({ onLookup }: { onLookup?: (email: string) => Promise<LicenseRow[]> }) {
  const go = useGo();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [rows, setRows] = useState<LicenseRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewBlocked, setPreviewBlocked] = useState(false);
  const [orderId, setOrderId] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      setFieldError("Enter the valid email address used at checkout.");
      return;
    }
    setFieldError("");
    setErr(null);
    setRows(null);
    if (!onLookup) {
      setPreviewBlocked(true);
      return;
    }
    setBusy(true);
    try {
      setRows(await onLookup(value));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  const track = (event: FormEvent) => {
    event.preventDefault();
    const v = orderId.trim();
    if (v) go(`/order/${encodeURIComponent(v)}`);
  };

  return (
    <section className="section">
      <div className="container">
        <div className="mx-auto max-w-3xl text-center">
          <Badge live>Provisioning desk online</Badge>
          <h1 className="display-lg balanced mt-7">Recover your license access.</h1>
          <p className="body-lg mx-auto mt-6 max-w-2xl">
            Enter the email you used at checkout. We'll show your most recent paid licenses.
            Subscription customers can sign in to the{" "}
            <SiteLink className="text-white underline underline-offset-4" href="/public/agent/login">
              customer portal
            </SiteLink>{" "}
            for their Meeting ID and devices.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-3xl">
          <form
            className="surface grid gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-end md:p-7"
            onSubmit={submit}
            noValidate
          >
            <TextField
              id="lookup"
              label="Checkout email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldError}
              placeholder="you@company.com"
              data-testid="input-license-email"
            />
            <ActionButton className="sm:mb-0.5" type="submit" disabled={busy} data-testid="button-license-lookup">
              {busy ? (
                <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
              ) : (
                <Search size={17} aria-hidden="true" />
              )}
              {busy ? "Searching" : "Look up license"}
            </ActionButton>
          </form>

          <div className="mt-6 grid gap-4" aria-live="polite">
            {busy && <div className="cl-skeleton h-40" />}
            {err && <Notice tone="error" title="Lookup failed">{err}</Notice>}
            {previewBlocked && (
              <Notice tone="warning" title="License lookup is not connected in this preview">
                This static preview does not query customer records. Your email was not sent
                anywhere. Use the live ConnectLive site to look up a license.
              </Notice>
            )}
            {rows && rows.length === 0 && (
              <div className="surface cl-pop p-7 text-center md:p-10">
                <CircleDashed className="mx-auto text-cl-warning" size={44} aria-hidden="true" />
                <h2 className="mt-6 font-display text-2xl">No paid license found for that email.</h2>
                <p className="mx-auto mt-3 max-w-lg text-sm leading-7 text-cl-muted">
                  If you just paid, it may take a few minutes to confirm on-chain.
                </p>
                <div className="mt-7">
                  <Button to="/contact">Get order help</Button>
                </div>
              </div>
            )}
            {rows?.map((r) => (
              <div key={r.id} className="surface cl-pop overflow-hidden" data-testid={`card-license-${r.id}`}>
                <div className="flex flex-col gap-4 border-b border-white/10 p-6 sm:flex-row sm:items-center sm:justify-between md:p-8">
                  <div>
                    <p className="hairline-title">
                      Paid license · Order {r.id.slice(0, 8)} · {new Date(r.created_at).toLocaleDateString()}
                    </p>
                    <h2 className="mt-3 font-display text-2xl capitalize">
                      {r.plan_code}{" "}
                      <span className="text-base text-cl-muted">· ${Number(r.amount_usd).toFixed(2)}</span>
                    </h2>
                  </div>
                  <Badge live={!!r.access_link}>{r.access_link ? "Ready to deploy" : "Preparing access"}</Badge>
                </div>
                <div className="grid gap-4 p-6 md:grid-cols-3 md:p-8">
                  {[
                    ["Order received", "Complete", CircleCheck],
                    ["Payment confirmed", "Complete", CircleCheck],
                    ["Access link", r.access_link ? "Ready now" : "Being prepared", PackageCheck],
                  ].map(([title, label, Icon]) => {
                    const I = Icon as typeof CircleCheck;
                    return (
                      <div className="rounded-xl border border-white/10 bg-white/5 p-5" key={title as string}>
                        <I size={21} className="text-cl-success" aria-hidden="true" />
                        <p className="mt-5 font-display text-lg">{title as string}</p>
                        <p className="mt-2 font-mono text-xs uppercase tracking-widest text-cl-faint">{label as string}</p>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t border-white/10 p-6 md:p-8">
                  {r.access_link ? (
                    <a className="button button-primary" href={r.access_link}>
                      <span className="relative z-10">Open access link</span>
                    </a>
                  ) : (
                    <p className="text-sm text-cl-warning">
                      Payment confirmed — access link is being prepared. Try again shortly.
                    </p>
                  )}
                  <Button to={`/order/${r.id}`} variant="secondary">
                    View invoice
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-cl-faint">Rate-limited to 5 lookups per email per hour.</p>

          <form id="track" onSubmit={track} className="surface mt-12 grid gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-end md:p-7">
            <TextField
              id="track-order"
              label="Track an order"
              help="Paste your order ID to see provisioning status and payment progress."
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="Order ID"
              data-testid="input-track-order"
            />
            <ActionButton type="submit" variant="secondary" className="sm:mb-7" data-testid="button-track-order">
              Track
            </ActionButton>
          </form>
        </div>
      </div>
    </section>
  );
}
