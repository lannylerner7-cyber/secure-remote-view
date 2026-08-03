import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminLoginCard } from "@/components/AdminLoginCard";

export const Route = createFileRoute("/connectlive/payment")({
  component: PaymentLoginPage,
  head: () => ({
    meta: [
      { title: "Payment admin sign-in — ConnectLive" },
      {
        name: "description",
        content:
          "Super-admin sign-in for the ConnectLive payments console: order reconciliation, crypto payment events and licence delivery.",
      },
      { property: "og:title", content: "Payment admin sign-in — ConnectLive" },
      {
        property: "og:description",
        content: "Super-admin access to ConnectLive order and payment reconciliation.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://zoomlite.live/connectlive/payment" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://zoomlite.live/connectlive/payment" }],
  }),
});

function PaymentLoginPage() {
  const navigate = useNavigate();
  return (
    <AdminLoginCard
      title="Payment admin sign in"
      subtitle="Sign in with a super-admin technician ID. Non-admins will be routed to the dashboard."
      onSuccess={() => navigate({ to: "/console", search: { tab: "payments" } })}
    />
  );
}
