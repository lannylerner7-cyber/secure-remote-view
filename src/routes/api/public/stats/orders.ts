import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/stats/orders")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { count, error } = await supabaseAdmin
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("status", "paid");
          if (error) throw error;
          return new Response(JSON.stringify({ paid: count ?? 0 }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=30, s-maxage=30",
            },
          });
        } catch {
          return new Response(JSON.stringify({ paid: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
