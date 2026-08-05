import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";

export const Route = createFileRoute("/terms")({
  component: Page,
  head: () => ({
    meta: [
      { title: "Terms of Service — ConnectLive" },
      {
        name: "description",
        content: "Terms governing the use of ConnectLive remote-support software.",
      },
      { property: "og:title", content: "ConnectLive Terms of Service" },
      {
        property: "og:description",
        content: "Terms governing the use of ConnectLive remote-support software.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://www.connectliveagent.com/terms" }],
  }),
});

function Page() {
  return (
    <LegalShell title="Terms of Service" updated="July 2026">
      <p>
        Installing or using ConnectLive means you're happy with the arrangement below. It's short on
        purpose.
      </p>
      <h2>Using it the right way</h2>
      <p>
        ConnectLive exists for honest support work, carried out with the knowledge and agreement of
        the person on the other side. Using it to reach a machine nobody agreed to hand over, to
        step around a security policy, or to do anything your local law forbids ends the
        arrangement on the spot.
      </p>
      <h2>What your plan covers</h2>
      <p>
        A paid plan gives your organisation a non-exclusive, non-transferable right to run the
        ConnectLive apps across the number of seats you bought. The right stays with you until you
        cancel or take a refund.
      </p>
      <h2>Consent is not optional</h2>
      <p>
        Every session opens with a visible prompt on the receiving screen. Disabling it, faking it,
        or hiding it is a breach of these terms and ends your licence immediately.
      </p>
      <h2>Where our responsibility stops</h2>
      <p>
        The software is provided as it is, without warranty of any kind. So far as the law allows,
        anything we owe you is capped at what you paid us over the previous twelve months.
      </p>
      <h2>Ending things</h2>
      <p>
        We can suspend access for a serious breach. You can walk away whenever you like — the Refund
        Policy explains what comes back to you.
      </p>
    </LegalShell>
  );
}
