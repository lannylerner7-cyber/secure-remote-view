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
      <h2>7-day satisfaction window</h2>
      <p>
        If ConnectLive doesn't work for you, request a refund within 7 days of purchase and we'll
        return the equivalent USD value in the same coin you paid with, less on-chain network fees.
      </p>
      <h2>How to request</h2>
      <p>
        Email <a href="mailto:billing@zoomlite.live">billing@zoomlite.live</a> from the address on
        your order, include your order ID, and the wallet address to refund to.
      </p>
      <h2>Timing</h2>
      <p>
        Refunds are processed within 3 business days of approval. On-chain settlement time depends
        on the network you selected (BTC: ~30 min, ERC-20: ~5 min).
      </p>
      <h2>Exclusions</h2>
      <ul>
        <li>Requests made after the 7-day window.</li>
        <li>Orders where the license has been transferred or shared beyond your seat count.</li>
        <li>Chargeback attempts on already-refunded orders.</li>
      </ul>
    </LegalShell>
  );
}
