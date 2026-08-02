import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Peer/target agent ACKs execution of a queued power_command.
 * Body: { state: "delivered" | "failed", error?: string }
 * Only the agent listed as relay_device_id (Wake) OR device_id (local action)
 * may ACK. Anything else is dropped.
 */
export const Route = createFileRoute("/api/public/agent/power/$cmdId/ack")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as { state?: string; error?: string };
        const state = body.state === "failed" ? "failed" : "delivered";

        const { data: cmd } = await ctx.admin
          .from("power_commands")
          .select("id, device_id, relay_device_id, kind, state")
          .eq("id", params.cmdId)
          .maybeSingle();
        if (!cmd) return new Response("not_found", { status: 404 });

        const authorized = cmd.relay_device_id === ctx.device.id || cmd.device_id === ctx.device.id;
        if (!authorized) return new Response("forbidden", { status: 403 });

        await ctx.admin
          .from("power_commands")
          .update({
            state,
            error: state === "failed" ? (body.error ?? "unknown").slice(0, 400) : null,
            delivered_at: new Date().toISOString(),
          })
          .eq("id", cmd.id);

        await ctx.admin.from("audit_logs").insert({
          event: `power.${cmd.kind}.${state}`,
          detail: {
            commandId: cmd.id,
            deviceId: cmd.device_id,
            relay: cmd.relay_device_id,
            error: body.error ?? null,
          },
        });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
