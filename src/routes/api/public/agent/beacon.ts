import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";
import { currentAuthorization } from "@/lib/authorization.server";

/**
 * Watch-app beacon. Fired by ConnectLiveWatch.exe (a tiny scheduled task
 * running every ~60 s) when it notices ConnectLive.exe is no longer running.
 * The main agent process cannot report its own death — Task Manager kill is
 * TerminateProcess, no cleanup runs. This reports an observed stopped process;
 * it does not establish an uninstall or explain why the process stopped.
 *
 * Auth: device token (same as heartbeat). Body: { reason }.
 */
export const Route = createFileRoute("/api/public/agent/beacon")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (ctx.kind !== "verified") return deviceAuthFailure(ctx);

        const body = (await request.json().catch(() => ({}))) as {
          reason?: "stopped" | "starting" | "uninstalling";
          authorizationId?: string;
        };
        const reason = body.reason === "starting" || body.reason === "uninstalling"
          ? body.reason
          : "stopped";

        let restartAuthorized = false;
        if (typeof body.authorizationId === "string" && body.authorizationId.length <= 64) {
          try {
            const grant = await currentAuthorization(ctx.admin, ctx.device.id);
            // Presence may continue while a license is dormant. Licensing
            // still gates sessions/capture in heartbeat; it is not a grant.
            restartAuthorized = !!grant && !grant.revokedAt && grant.id === body.authorizationId;
          } catch {
            return new Response("authorization_unavailable", { status: 503 });
          }
        }

        if (reason === "stopped" || reason === "uninstalling") {
          const update = ctx.admin
            .from("devices")
            .update({ status: "stopped" })
            .eq("id", ctx.device.id);
            // An old observation cannot overwrite a newer heartbeat. Watch
            // reports never advance the Agent's own last_seen_at.
          const { data: updated, error } = await (ctx.device.last_seen_at
            ? update.eq("last_seen_at", ctx.device.last_seen_at)
            : update.is("last_seen_at", null)).select("id");
          if (error) return new Response("presence_write_failed", { status: 503 });

          if (updated?.length && ctx.device.status !== "stopped") {
          const { error: notificationError } = await ctx.admin.from("notifications").insert({
            recipient_id: null,
            title: reason === "uninstalling" ? "Agent removal reported" : "Agent stopped",
            body:
              reason === "uninstalling"
                ? `${ctx.device.display_name} (${ctx.device.device_id}) reported the agent is being uninstalled`
                : `Watch observed no running Agent on ${ctx.device.display_name} (${ctx.device.device_id}); the cause is not established`,
            severity: reason === "uninstalling" ? "warning" : "error",
          });
          if (notificationError) return new Response("notification_write_failed", { status: 503 });
          }
        }
        // "starting" is informational — we let the next /heartbeat flip
        // status back to online. No row change here.

        return new Response(JSON.stringify({ ok: true, restart_authorized: restartAuthorized }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
