import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";

export const Route = createFileRoute("/refund")({
  component: Page,
  head: () => ({
    meta: [
      { title: "Refund Policy — ConnectLive" },
      { name: "description", content: "How refunds work for ConnectLive licenses." },
      { property: "og:title", content: "ConnectLive Refund Policy" },
      { property: "og:description", content: "How refunds work for ConnectLive licenses." },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function Page() {
  return (
    <LegalShell title="Refund Policy" updated="July 2026">
      <h2>Seven days to change your mind</h2>
      <p>
        If ConnectLive isn't the fit you hoped for, say so within seven days of buying and we'll
        send back the same USD value in the coin you paid with, minus whatever the network charges
        to move it.
      </p>
      <h2>Asking for one</h2>
      <p>
        Email <a href="mailto:support@connectliveagent.com">support@connectliveagent.com</a> from
        the address on the order. Include the order ID and the wallet that should receive the
        funds — that's the whole process.
      </p>
      <h2>How quickly it lands</h2>
      <p>
        We approve or query within three business days. After that the clock belongs to the chain
        you chose: Bitcoin usually settles in about half an hour, ERC-20 in roughly five minutes.
      </p>
      <h2>The few things we can't refund</h2>
      <ul>
        <li>Requests that arrive after the seven-day window has closed.</li>
        <li>Licences that have been passed on or stretched past the seats they cover.</li>
        <li>Chargebacks raised against an order we've already refunded.</li>
      </ul>
    </LegalShell>
  );
}
