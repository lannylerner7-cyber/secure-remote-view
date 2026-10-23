import { useState } from "react";
import { Check } from "lucide-react";
import { comparisonRows, faqs, plans } from "./data";
import { PricingCard } from "./pricing-card";
import { ActionButton, Badge, Button, SectionHeading } from "./ui";

export function PlansContent() {
  const [mobilePlan, setMobilePlan] = useState(1);

  return (
    <>
      <section className="section-tight border-b border-white/10">
        <div className="container pt-8 text-center">
          <Badge>Simple capacity, clear control</Badge>
          <h1 className="display-lg balanced mx-auto mt-7 max-w-4xl">
            Choose the surface area your team needs.
          </h1>
          <p className="body-lg mx-auto mt-6 max-w-2xl">
            Every plan includes authorized device enrollment, encrypted transport, curtain mode, and
            an operator audit trail.
          </p>
          <div className="mt-9">
            <Badge>Promo pricing · billed monthly · up to 46% off</Badge>
          </div>
        </div>
      </section>

      <section className="section-tight">
        <div className="container grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => (
            <PricingCard key={plan.slug} plan={plan} />
          ))}
        </div>
      </section>

      <section className="section border-y border-white/10 bg-cl-panel">
        <div className="container">
          <SectionHeading
            eyebrow="Compare"
            title="Every detail, side by side."
            copy="Select a plan on mobile to inspect its included capacity and controls."
          />
          <div className="mt-12 hidden overflow-hidden rounded-2xl border border-white/10 lg:block">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-white/5">
                  <th className="p-5 font-mono text-xs uppercase tracking-widest text-cl-faint">
                    Capability
                  </th>
                  {plans.map((plan) => (
                    <th className="p-5 font-display text-lg" key={plan.slug}>
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr className="border-t border-white/10" key={row.label}>
                    <th className="p-5 text-sm font-semibold">{row.label}</th>
                    {row.values.map((value, index) => (
                      <td className="p-5 text-sm text-cl-muted" key={plans[index].slug}>
                        <span className="flex items-center gap-2">
                          <Check size={14} className="shrink-0 text-cl-success" aria-hidden="true" />
                          {value}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-10 lg:hidden">
            <div className="flex gap-2 overflow-x-auto pb-3" role="tablist">
              {plans.map((plan, index) => (
                <ActionButton
                  key={plan.slug}
                  role="tab"
                  aria-selected={mobilePlan === index}
                  className={`!min-h-10 shrink-0 !px-4 !py-1 ${mobilePlan === index ? "!bg-white !text-cl-canvas" : ""}`}
                  variant="secondary"
                  onClick={() => setMobilePlan(index)}
                >
                  {plan.name}
                </ActionButton>
              ))}
            </div>
            <div key={mobilePlan} className="surface cl-pop mt-4 p-6">
              <h2 className="font-display text-2xl">{plans[mobilePlan].name}</h2>
              <div className="mt-6 grid gap-5">
                {comparisonRows.map((row) => (
                  <div key={row.label}>
                    <p className="hairline-title">{row.label}</p>
                    <p className="mt-2 text-sm text-cl-muted">{row.values[mobilePlan]}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container grid gap-12 lg:grid-cols-[0.7fr_1.3fr]">
          <div>
            <p className="eyebrow">Planning notes</p>
            <h2 className="display-md mt-6">Clear answers before you commit.</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {faqs.slice(0, 4).map((item) => (
              <article className="surface p-6" key={item.question}>
                <h3 className="font-display text-lg">{item.question}</h3>
                <p className="mt-3 text-sm leading-7 text-cl-muted">{item.answer}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section-tight border-t border-white/10">
        <div className="container surface flex flex-col gap-7 p-8 md:flex-row md:items-center md:justify-between md:p-12">
          <div>
            <p className="eyebrow">Enterprise</p>
            <h2 className="display-md mt-4">Need a custom operating model?</h2>
          </div>
          <Button to="/contact">Talk to sales</Button>
        </div>
      </section>
    </>
  );
}
