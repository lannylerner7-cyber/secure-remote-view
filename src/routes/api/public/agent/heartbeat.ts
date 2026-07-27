import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Called every ~15s by the agent, and every 5-60s by the SYSTEM watcher.
 * Returns pending session invites + is_session_active so the watcher can
 * revive ConnectLiveAgent.exe if it crashed or the user closed it.
 *
 * Reconnect detection uses a timestamp delta: any gap > 60s (or a non-
 * "online" prior status) fires a broadcast "Device reconnected" notification,
 * so post-reboot recoveries are visible in the admin panel even when no
 * offline sweeper has run.
 */
const RECONNECT_GAP_MS = 60_000;

export const Route = createFileRoute("/api/public/agent/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const nowIso = new Date().toISOString();
        const prevStatus = ctx.device.status;
        const prevSeen = ctx.device.last_seen_at ? new Date(ctx.device.last_seen_at).getTime() : 0;
        const gap = Date.now() - prevSeen;
        const wasOffline = prevStatus !== "online" || gap > RECONNECT_GAP_MS;

        await ctx.admin
          .from("devices")
          .update({ status: "online", last_seen_at: nowIso })
          .eq("id", ctx.device.id);

        const { data: pending } = await ctx.admin
          .from("sessions")
          .select("id, mode, state")
          .eq("device_id", ctx.device.id)
          .in("state", ["invited", "consented", "active", "paused"])
          .order("created_at", { ascending: false });

        const isSessionActive = (pending ?? []).length > 0;

        if (wasOffline) {
          // Broadcast to all admins (recipient_id NULL); RLS allows read for authenticated.
          await ctx.admin.from("notifications").insert({
            recipient_id: null,
            title: "Device reconnected",
            body: `${ctx.device.display_name} (${ctx.device.device_id}) is back online`,
            severity: "success",
          });
        }

        return new Response(
          JSON.stringify({
            ok: true,
            is_session_active: isSessionActive,
            sessions: pending ?? [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
