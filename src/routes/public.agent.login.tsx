import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AdminLoginCard } from "@/components/AdminLoginCard";

export const Route = createFileRoute("/public/agent/login")({
  component: CustomerLoginPage,
  head: () => ({
    meta: [
      { title: "Customer sign-in — ConnectLive licence portal" },
      {
        name: "description",
        content:
          "Sign in to the ConnectLive customer portal to see your Meeting ID, manage enrolled devices and renew your subscription.",
      },
      { property: "og:title", content: "Customer sign-in — ConnectLive" },
      {
        property: "og:description",
        content: "Manage your ConnectLive licence, Meeting ID and enrolled devices.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://connectliveagent.com/public/agent/login" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://connectliveagent.com/public/agent/login" }],
  }),
});

function CustomerLoginPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-[#0F1626]">
      <AdminLoginCard
        title="Customer sign in"
        subtitle="Use the email and password issued with your ConnectLive subscription."
        onSuccess={() => navigate({ to: "/public/agent/portal" })}
      />
      <p className="pb-10 text-center text-xs text-white/40">
        Technician?{" "}
        <Link to="/connectlive/admin" className="text-[#4F7CFF] hover:underline">
          Sign in here
        </Link>
      </p>
    </div>
  );
}
