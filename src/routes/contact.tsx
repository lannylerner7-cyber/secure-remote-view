import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { submitContactMessage } from "@/lib/contact.functions";
import { SiteShell } from "@/components/site/layout";
import { ContactPanel } from "@/components/site/contact-panel";

export const Route = createFileRoute("/contact")({
  component: Page,
  head: () => ({
    meta: [
      { title: "Contact — ConnectLive" },
      { name: "description", content: "Get in touch with the ConnectLive team." },
      { property: "og:title", content: "Contact ConnectLive" },
      { property: "og:description", content: "Get in touch with the ConnectLive team." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://www.connectliveagent.com/contact" }],
  }),
});

function Page() {
  const send = useServerFn(submitContactMessage);
  return (
    <SiteShell>
      <ContactPanel
        onSend={async (input) => {
          const res = await send({ data: input });
          return { ok: res.ok, message: res.message, reference: res.reference };
        }}
      />
    </SiteShell>
  );
}
