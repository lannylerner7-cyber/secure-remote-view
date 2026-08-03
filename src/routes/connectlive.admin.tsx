import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminLoginCard } from "@/components/AdminLoginCard";

export const Route = createFileRoute("/connectlive/admin")({
  component: LoginPage,
  head: () => ({
    meta: [
      { title: "Technician sign-in — ConnectLive" },
      {
        name: "description",
        content:
          "Secure sign-in for ConnectLive technicians. Consent-based remote support sessions, with lockout after three failed attempts.",
      },
      { property: "og:title", content: "Technician sign-in — ConnectLive" },
      {
        property: "og:description",
        content: "Secure sign-in for ConnectLive technicians and support staff.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://zoomlite.live/connectlive/admin" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://zoomlite.live/connectlive/admin" }],
  }),
});

function LoginPage() {
  const navigate = useNavigate();
  return (
    <AdminLoginCard
      title="Technician sign in"
      subtitle="Use your ConnectLive technician ID. Three failed attempts trigger a 1-hour lockout."
      onSuccess={() => navigate({ to: "/console" })}
    />
  );
}
