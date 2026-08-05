import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";
import { ContactForm } from "@/components/ContactForm";

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
  return (
    <LegalShell title="Contact us" updated="">
      <p>
        Tell us what's going on and the whole support team sees it. You'll get an instant
        confirmation, and a human reply inside one business day — usually much sooner.
      </p>

      <div className="not-prose mt-6">
        <ContactForm source="contact" />
      </div>

      <p className="mt-8">
        If a live session is stuck right now, drop your order ID or meeting code into the message and
        it jumps the queue. Prefer plain email? Write to{" "}
        <a href="mailto:support@connectliveagent.com">support@connectliveagent.com</a>.
      </p>
    </LegalShell>
  );
}
