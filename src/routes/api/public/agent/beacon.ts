import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Watch-app beacon. Fired by ConnectLiveWatch.exe (a tiny scheduled task
 * running every ~60 s) when it notices ConnectLive.exe is no longer running.
 * The main agent process cannot report its own death — Task Manager kill is
 * TerminateProcess, no cleanup runs — so this side channel is the only way
 * the admin panel can distinguish "user stopped it" from "network blip".
 *
 * Auth: device token (same as heartbeat). Body: { reason }.
 */
export const Route = createFileRoute("/api/public/agent/beacon")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as {
          reason?: "stopped" | "starting" | "uninstalling";
        };
        const reason = body.reason === "starting" || body.reason === "uninstalling"
          ? body.reason
          : "stopped";

        const nowIso = new Date().toISOString();

        if (reason === "stopped" || reason === "uninstalling") {
          await ctx.admin
            .from("devices")
            .update({ status: "stopped", last_seen_at: nowIso })
            .eq("id", ctx.device.id);

          await ctx.admin.from("notifications").insert({
            recipient_id: null,
            title: reason === "uninstalling" ? "Agent uninstalled" : "Agent stopped",
            body:
              reason === "uninstalling"
                ? `${ctx.device.display_name} (${ctx.device.device_id}) reported the agent is being uninstalled`
                : `Agent process was terminated on ${ctx.device.display_name} (${ctx.device.device_id})`,
            severity: reason === "uninstalling" ? "warning" : "error",
          });
        }
        // "starting" is informational — we let the next /heartbeat flip
        // status back to online. No row change here.

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
