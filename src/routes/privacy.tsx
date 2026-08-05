import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";

export const Route = createFileRoute("/privacy")({
  component: Page,
  head: () => ({
    meta: [
      { title: "Privacy Policy — ConnectLive" },
      {
        name: "description",
        content: "How ConnectLive handles your data during and after remote support sessions.",
      },
      { property: "og:title", content: "ConnectLive Privacy Policy" },
      {
        property: "og:description",
        content: "How ConnectLive handles your data during and after remote support sessions.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function Page() {
  return (
    <LegalShell title="Privacy Policy" updated="July 2026">
      <p>
        This page is written in plain language so you always know where your information lives, why
        we have it, and when it goes away. If anything here is unclear, tell us — we'll rewrite it.
      </p>
      <h2>Information we hold</h2>
      <ul>
        <li>
          <strong>Your account.</strong> A name, an email, and — if you share them — a phone number
          and company. Enough to send you a receipt and to help when you write in.
        </li>
        <li>
          <strong>Your order.</strong> The plan you picked, the coin you paid with, and the
          on-chain address issued to that order. Wallet keys never leave your device.
        </li>
        <li>
          <strong>Working memory.</strong> While a support session is open, the pixels and inputs
          needed to keep the two ends in sync briefly pass through our relays. They are not stored.
        </li>
        <li>
          <strong>Device fingerprints.</strong> A short device token, operating system name, and
          heartbeat timestamps so we can route the right session to the right machine.
        </li>
      </ul>
      <h2>Information we deliberately avoid</h2>
      <p>
        We don't sit on top of your files, we don't quietly record sessions, and no piece of our
        software opens a connection without the person at the keyboard agreeing to it first.
      </p>
      <h2>How long anything sticks around</h2>
      <ul>
        <li>Live-session buffers are cleared within minutes of the session closing.</li>
        <li>Orders and receipts are kept for as long as accounting rules require.</li>
        <li>Operational logs roll off automatically after 90 days.</li>
      </ul>
      <h2>Getting in touch about your data</h2>
      <p>
        Write to <a href="mailto:support@connectliveagent.com">support@connectliveagent.com</a> and
        a human will answer — usually the same day.
      </p>
    </LegalShell>
  );
}
