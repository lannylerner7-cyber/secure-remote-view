import { knowledgeEntries } from "./guide-knowledge";
import { SiteLink } from "../adapter";

export const GUIDE_QUICK_TOPICS = [
  { label: "About", id: "about-what" },
  { label: "Support", id: "support-contact" },
  { label: "Order", id: "order-start" },
  { label: "Order status", id: "pay-status" },
  { label: "Newsletter", id: "site-newsletter" },
  { label: "Pricing", id: "plans-list" },
  { label: "Agent setup", id: "enroll-how" },
  { label: "YouTube", id: "site-youtube" },
  { label: "Experience", id: "site-experience" },
  { label: "One-time Admin", id: "plans-one-time-admin" },
  { label: "Refunds", id: "support-refund" },
] as const;

/** Render real text on the server, not a crawler-only copy or a client-fetched
 * chat transcript. Visitors and crawlers receive the same approved wording. */
export function GuideQuickAnswers() {
  return (
    <details className="gd-quick-answers mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 md:p-6" data-testid="guide-quick-answers">
      <summary className="cursor-pointer text-sm font-medium text-cl-signal-bright">
        Browse quick answers
        <span className="ml-2 text-xs font-normal text-cl-muted">Agent setup, pricing, support and more</span>
      </summary>
      <dl className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {GUIDE_QUICK_TOPICS.map((topic) => {
          const entry = knowledgeEntries.find((candidate) => candidate.id === topic.id);
          if (!entry) return null;
          return (
            <div key={entry.id} id={`guide-topic-${topic.id}`} className="scroll-mt-28">
              <dt className="text-sm font-semibold text-white">{topic.label}</dt>
              <dd className="mt-2 text-sm leading-6 text-cl-muted">
                <p>{entry.dynamic === "plans"
                  ? "See the Plans page for current monthly prices, device allowances, and included features. Prices come from the live catalog."
                  : entry.answer}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {entry.links?.map((link) => (
                    <SiteLink key={link.to} href={link.to} className="text-xs text-cl-signal-bright underline underline-offset-4 hover:text-white">
                      {link.label}
                    </SiteLink>
                  ))}
                </div>
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
