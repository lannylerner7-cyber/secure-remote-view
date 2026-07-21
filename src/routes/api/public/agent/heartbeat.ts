import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Called every ~20s by the agent. Also returns any pending session invites.
 */
export const Route = createFileRoute("/api/public/agent/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        await ctx.admin
          .from("devices")
          .update({ status: "online", last_seen_at: new Date().toISOString() })
          .eq("id", ctx.device.id);

        const { data: pending } = await ctx.admin
          .from("sessions")
          .select("id, mode, state")
          .eq("device_id", ctx.device.id)
          .in("state", ["invited", "consented", "active", "paused"])
          .order("created_at", { ascending: false });

        return new Response(JSON.stringify({ ok: true, sessions: pending ?? [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
