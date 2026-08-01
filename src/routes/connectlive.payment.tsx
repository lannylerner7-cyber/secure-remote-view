import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminLoginCard } from "@/components/AdminLoginCard";

export const Route = createFileRoute("/connectlive/payment")({
  component: PaymentLoginPage,
  head: () => ({
    meta: [
      { title: "Payment admin sign-in — ConnectLive" },
      { name: "robots", content: "noindex" },
    ],
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
