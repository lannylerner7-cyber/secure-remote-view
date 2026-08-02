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
        ConnectLive is a consent-based remote-support tool. This policy explains what we collect,
        why, and how long we keep it.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account data</strong> for buyers: name, email, optional phone and company, and the
          plan you purchased.
        </li>
        <li>
          <strong>Payment data</strong>: the coin, on-chain address issued to your order, and
          confirmation status. We never see your wallet keys.
        </li>
        <li>
          <strong>Session data</strong>: while a technician is connected, screen frames, cursor
          position, and admin-issued inputs pass through our servers only for the duration of the
          session.
        </li>
        <li>
          <strong>Device metadata</strong>: a short-lived device token, OS name, and heartbeat
          timestamps used to route sessions.
        </li>
      </ul>
      <h2>What we do not collect</h2>
      <p>
        We do not record sessions. We do not read files on your device. We do not run a background
        service that connects without your explicit consent — every session begins with an on-screen
        prompt you must accept.
      </p>
      <h2>Retention</h2>
      <ul>
        <li>Session frames and cursor positions are deleted within minutes of a session ending.</li>
        <li>Order and payment records are kept for accounting purposes.</li>
        <li>Audit logs are kept for 90 days.</li>
      </ul>
      <h2>Contact</h2>
      <p>
        Questions? Reach us at <a href="mailto:privacy@zoomlite.live">privacy@zoomlite.live</a>.
      </p>
    </LegalShell>
  );
}
