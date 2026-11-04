import { Check, RefreshCw } from "lucide-react";
import type { DisplayPlan } from "./data";
import { formatPrice, usePlanCatalog } from "./plan-catalog";
import { ActionButton, Badge, Button } from "./ui";

export function PricingCard({ plan, compact = false }: { plan: DisplayPlan; compact?: boolean }) {
  const catalog = usePlanCatalog();
  const custom = plan.contactPricing === true;
  const price = custom ? null : catalog.priceFor(plan.slug);
  const missing = !custom && catalog.status === "ready" && price === null;
  return (
    <article
      data-testid={`card-plan-${plan.slug}`}
      className={`surface relative flex h-full flex-col p-6 transition duration-200 hover:-translate-y-1 hover:border-white/25 ${
        plan.featured ? "ring-1 ring-cl-signal/50" : ""
      }`}
    >
      {plan.featured && (
        <div className="absolute right-5 top-5">
          <Badge>Recommended</Badge>
        </div>
      )}
      <p className="hairline-title">{plan.name}</p>
      <div
        className="mt-8 flex min-h-12 flex-wrap items-end gap-2"
        data-testid={`text-plan-price-${plan.slug}`}
        data-price-state={custom ? "custom" : price !== null ? "ready" : missing ? "missing" : catalog.status}
        aria-live="polite"
      >
        {custom ? (
          <strong className="font-display text-4xl tracking-tight">Custom</strong>
        ) : price !== null ? (
          <>
            <strong className="tabular font-display text-5xl tracking-[-0.05em]">${formatPrice(price)}</strong>
            <span className="mb-1 text-sm text-cl-muted">/ month</span>
          </>
        ) : catalog.status === "loading" ? (
          <>
            <span className="cl-skeleton h-11 w-28" aria-hidden="true" />
            <span className="sr-only">Loading current price</span>
          </>
        ) : missing ? (
          <span className="font-display text-xl text-cl-muted">Not currently offered</span>
        ) : (
          <span className="font-display text-xl text-cl-muted">Price unavailable</span>
        )}
      </div>
      <p className="mt-5 min-h-12 text-sm leading-6 text-cl-muted">{plan.description}</p>
      <div className="metal-line my-6" />
      <ul className="grid gap-3 text-sm text-cl-muted">
        {[plan.devices, plan.operators, plan.retention, plan.support].map((item) => (
          <li key={item} className="flex gap-3">
            <Check className="mt-0.5 shrink-0 text-cl-signal-bright" size={16} aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-7">
        {custom ? (
          <Button to="/contact" variant={plan.featured ? "primary" : "secondary"} full data-testid={`link-plan-${plan.slug}`}>
            Talk to sales
          </Button>
        ) : price !== null ? (
          <Button
            to={`/order?plan=${plan.slug}`}
            variant={plan.featured ? "primary" : "secondary"}
            full
            data-testid={`link-plan-${plan.slug}`}
          >
            {compact ? "Choose plan" : `Start with ${plan.name}`}
          </Button>
        ) : catalog.status === "error" ? (
          <ActionButton variant="secondary" full onClick={catalog.retry} data-testid={`button-plan-retry-${plan.slug}`}>
            <RefreshCw size={15} aria-hidden="true" /> Retry prices
          </ActionButton>
        ) : missing ? (
          <Button to="/contact" variant="secondary" full data-testid={`link-plan-contact-${plan.slug}`}>
            Ask the team
          </Button>
        ) : (
          <ActionButton variant="secondary" full disabled data-testid={`button-plan-loading-${plan.slug}`}>
            Checking current price
          </ActionButton>
        )}
      </div>
    </article>
  );
}

/** Banner shown above plan grids when the live catalog cannot be verified. */
export function CatalogStatusNotice() {
  const catalog = usePlanCatalog();
  if (catalog.status !== "error") return null;
  return (
    <div
      className="surface mb-6 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
      role="status"
      data-testid="status-plan-catalog"
      data-catalog-state="error"
    >
      <div>
        <p className="hairline-title">Live pricing unavailable</p>
        <p className="mt-2 text-sm text-cl-muted">
          {catalog.error} Paid plans can be ordered as soon as current prices are confirmed.
        </p>
      </div>
      <ActionButton variant="secondary" onClick={catalog.retry} data-testid="button-plan-catalog-retry">
        <RefreshCw size={15} aria-hidden="true" /> Try again
      </ActionButton>
    </div>
  );
}
