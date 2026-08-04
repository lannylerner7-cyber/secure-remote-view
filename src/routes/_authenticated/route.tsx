import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "ConnectLive Console — Technician Workspace" },
      {
        name: "description",
        content:
          "Authenticated ConnectLive technician console for consent-based remote support sessions.",
      },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:title", content: "ConnectLive Console" },
      {
        property: "og:description",
        content: "Authenticated ConnectLive technician console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/connectlive/admin" });
    return { user: data.user };
  },
  component: () => <Outlet />,
});
