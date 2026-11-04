import { createFileRoute } from "@tanstack/react-router";
import bannerImage from "@/assets/connectlive-banner.jpg";
import { getActivePlansPublic } from "@/lib/orders.functions";
import type { CatalogPlan } from "@/components/site/plan-catalog";
import { SiteShell } from "@/components/site/layout";
import { HomeContent } from "@/components/site/home";

export const Route = createFileRoute("/")({
  component: Home,
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
      { title: "ConnectLive — Enterprise Remote Support Platform" },
      {
        name: "description",
        content:
          "ConnectLive is an authorised remote-support platform for IT, help desks, and enterprise fleets. Sub-50ms sessions, curtain mode, and a full audit trail.",
      },
      { property: "og:title", content: "ConnectLive — Remote Support Platform" },
      {
        property: "og:description",
        content:
          "Authorised remote support for 10 to unlimited devices. Precise, secure, auditable.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: new URL(bannerImage, "https://connectliveagent.com").href },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: new URL(bannerImage, "https://connectliveagent.com").href },

    ],
    links: [{ rel: "canonical", href: "https://www.connectliveagent.com/" }],
  }),
});

function Home() {
  return (
    <SiteShell initialCatalog={Route.useLoaderData().catalog}>
      <HomeContent />
    </SiteShell>
  );
}
