import { Check } from "lucide-react";
import { WAS_PRICE, type DisplayPlan } from "./data";
import { Badge, Button } from "./ui";

export function PricingCard({ plan, compact = false }: { plan: DisplayPlan; compact?: boolean }) {
  const price = plan.monthly;
  const custom = price === null;
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
      <div className="mt-8 flex flex-wrap items-end gap-2">
        {custom ? (
          <strong className="font-display text-4xl tracking-tight">Custom</strong>
        ) : (
          <>
            {WAS_PRICE[plan.slug] && (
              <span className="mb-2 font-mono text-sm text-cl-faint line-through">
                ${WAS_PRICE[plan.slug]}
              </span>
            )}
            <strong className="font-display text-5xl tracking-[-0.05em]">${price}</strong>
            <span className="mb-1 text-sm text-cl-muted">/ month</span>
          </>
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
        <Button
          to={custom ? "/contact" : `/order?plan=${plan.slug}`}
          variant={plan.featured ? "primary" : "secondary"}
          full
          data-testid={`link-plan-${plan.slug}`}
        >
          {custom ? "Talk to sales" : compact ? "Choose plan" : `Start with ${plan.name}`}
        </Button>
      </div>
    </article>
  );
}
