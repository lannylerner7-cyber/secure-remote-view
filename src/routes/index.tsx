import { createFileRoute } from "@tanstack/react-router";
import bannerImage from "@/assets/connectlive-banner.jpg";
import { SiteShell } from "@/components/site/layout";
import { HomeContent } from "@/components/site/home";

export const Route = createFileRoute("/")({
  component: Home,
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
    <SiteShell>
      <HomeContent />
    </SiteShell>
  );
}
