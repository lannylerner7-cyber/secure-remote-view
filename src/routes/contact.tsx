import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";

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
        Email still beats every form we could build. One inbox, watched by the whole team — you'll
        hear back inside one business day.
      </p>
      <ul>
        <li>
          <strong>Orders, billing, technical issues, privacy:</strong>{" "}
          <a href="mailto:support@connectliveagent.com">support@connectliveagent.com</a>
        </li>
      </ul>

      <p>
        If a live session is stuck right now, put your order ID or meeting code in the subject line
        and it jumps the queue.
      </p>
    </LegalShell>
  );
}
