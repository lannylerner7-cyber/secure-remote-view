import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CreditCard, LogOut, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getMyRole, type AppRole } from "@/lib/admins.functions";
import { PaymentsPanel } from "@/components/PaymentsPanel";

export const Route = createFileRoute("/_authenticated/payments")({
  component: PaymentsConsole,
  head: () => ({
    meta: [
      { title: "Payments console — ConnectLive" },
      {
        name: "description",
        content: "Order reconciliation, crypto payment events and licence delivery.",
      },
      { property: "og:title", content: "Payments console — ConnectLive" },
      {
        property: "og:description",
        content: "Order reconciliation, crypto payment events and licence delivery.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

function PaymentsConsole() {
  const navigate = useNavigate();
  const [role, setRole] = useState<AppRole | null | "loading">("loading");
  const [email, setEmail] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
    getMyRole()
      .then((r) => setRole(r.role))
      .catch(() => setRole(null));
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/connectlive/payment" });
  };

  const allowed = role === "admin" || role === "super_admin";

  return (
    <div className="min-h-screen bg-[#0B1220] text-white">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-white/10 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-2">
          <CreditCard className="h-5 w-5 shrink-0 text-[#4F7CFF]" />
          <span className="truncate text-base font-semibold sm:text-lg">Payments console</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <span className="hidden max-w-[180px] truncate text-xs text-white/50 sm:inline">
            {email}
          </span>
          <Link
            to="/console"
            className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:bg-white/5"
          >
            Technician console
          </Link>
          <button
            onClick={signOut}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:bg-white/5"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      <main className="p-4 sm:p-6">
        {role === "loading" && <div className="text-sm text-white/50">Loading…</div>}
        {role !== "loading" && !allowed && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              This account is not a payments administrator. Ask a super-admin to grant the admin
              role, or return to the{" "}
              <Link to="/console" className="underline">
                technician console
              </Link>
              .
            </div>
          </div>
        )}
        {allowed && <PaymentsPanel isSuperAdmin={role === "super_admin"} />}
      </main>
    </div>
  );
}
