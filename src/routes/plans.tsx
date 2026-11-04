import { createFileRoute } from "@tanstack/react-router";
import { getActivePlansPublic } from "@/lib/orders.functions";
import type { CatalogPlan } from "@/components/site/plan-catalog";
import { SiteShell } from "@/components/site/layout";
import { PlansContent } from "@/components/site/plans";

export const Route = createFileRoute("/plans")({
  component: PlansPage,
  loader: async () => {
    try {
      const plans = await getActivePlansPublic();
      return { catalog: { plans: plans as CatalogPlan[], error: null } };
    } catch {
      return {
        catalog: {
          plans: null,
          error: "Current prices are temporarily unavailable. Please try again.",
        },
      };
    }
  },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  head: () => ({
    meta: [
      { title: "Plans and pricing — ConnectLive" },
      {
        name: "description",
        content:
          "ConnectLive remote-support plans: Starter, Team, Business, and custom Enterprise. Monthly pricing, paid in BTC, USDT, or USDC.",
      },
      { property: "og:title", content: "ConnectLive plans and pricing" },
      { property: "og:description", content: "Choose the surface area your team needs." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://www.connectliveagent.com/plans" }],
  }),
});

function PlansPage() {
  return (
    <SiteShell initialCatalog={Route.useLoaderData().catalog}>
      <PlansContent />
    </SiteShell>
  );
}
