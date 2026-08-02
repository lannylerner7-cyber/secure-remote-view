import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminLoginCard } from "@/components/AdminLoginCard";

export const Route = createFileRoute("/connectlive/admin")({
  component: LoginPage,
  head: () => ({
    meta: [{ title: "Technician sign-in — ConnectLive" }, { name: "robots", content: "noindex" }],
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
