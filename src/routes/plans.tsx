import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "@/components/site/layout";
import { PlansContent } from "@/components/site/plans";

export const Route = createFileRoute("/plans")({
  component: PlansPage,
  head: () => ({
    meta: [
      { title: "Plans and pricing — ConnectLive" },
      {
        name: "description",
        content:
          "ConnectLive remote-support plans: Starter, Team, Business, and custom Enterprise. Promo pricing, paid in BTC, USDT, or USDC.",
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
    <SiteShell>
      <PlansContent />
    </SiteShell>
  );
}
