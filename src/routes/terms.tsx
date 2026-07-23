import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";

export const Route = createFileRoute("/terms")({
  component: Page,
  head: () => ({
    meta: [
      { title: "Terms of Service — ConnectLive" },
      { name: "description", content: "Terms governing the use of ConnectLive remote-support software." },
      { property: "og:title", content: "ConnectLive Terms of Service" },
      { property: "og:description", content: "Terms governing the use of ConnectLive remote-support software." },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function Page() {
  return (
    <LegalShell title="Terms of Service" updated="July 2026">
      <p>By downloading, installing, or using ConnectLive, you agree to these terms.</p>
      <h2>Acceptable use</h2>
      <p>ConnectLive is licensed for legitimate IT support with the informed consent of the end user on every session. You may not use ConnectLive to access a device without the current user's explicit approval, to bypass corporate security policies, or in any way that violates local law.</p>
      <h2>Licensing</h2>
      <p>A paid plan grants a non-exclusive, non-transferable right to use the ConnectLive agent and admin console for the number of seats/devices covered by your plan. Licenses do not expire until refunded or cancelled.</p>
      <h2>Consent architecture</h2>
      <p>ConnectLive requires an on-screen consent prompt at every session start. Disabling, spoofing, or hiding this prompt violates these terms and terminates your license immediately.</p>
      <h2>Warranty and liability</h2>
      <p>ConnectLive is provided "as is" without warranty. To the maximum extent permitted by law, our aggregate liability is limited to the amount you paid for your license in the trailing 12 months.</p>
      <h2>Termination</h2>
      <p>We may suspend or terminate access for material breach of these terms. You may cancel any time; see the Refund Policy.</p>
    </LegalShell>
  );
}
