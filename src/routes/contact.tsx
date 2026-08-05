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
  }),
});

function Page() {
  return (
    <LegalShell title="Contact us" updated="">
      <p>The fastest way to reach us is email. We reply within one business day.</p>
      <ul>
        <li>
          <strong>Sales & billing:</strong>{" "}
          <a href="mailto:billing@connectliveagent.com">billing@connectliveagent.com</a>
        </li>
        <li>
          <strong>Support:</strong> <a href="mailto:support@connectliveagent.com">support@connectliveagent.com</a>
        </li>
        <li>
          <strong>Privacy & security:</strong>{" "}
          <a href="mailto:privacy@connectliveagent.com">privacy@connectliveagent.com</a>
        </li>
      </ul>
      <p>
        For urgent live-session issues, include your order ID or meeting code in the subject line.
      </p>
    </LegalShell>
  );
}
