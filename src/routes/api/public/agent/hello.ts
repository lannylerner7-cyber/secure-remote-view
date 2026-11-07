import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";

/**
 * "Hello admin, I'm here" — first call after a fresh session start.
 * Sets device online and appends an audit entry.
 */
export const Route = createFileRoute("/api/public/agent/hello")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (ctx.kind !== "verified") return deviceAuthFailure(ctx);

        await ctx.admin
          .from("devices")
          .update({ status: "online", last_seen_at: new Date().toISOString() })
          .eq("id", ctx.device.id);

        await ctx.admin.from("audit_logs").insert({
          device_id: ctx.device.id,
          event: "agent.hello",
          detail: {},
        });

        return new Response(JSON.stringify({ ok: true, deviceId: ctx.device.device_id }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
