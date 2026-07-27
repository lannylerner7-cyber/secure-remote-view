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

        // Optional LAN fingerprint (best-effort) used for Wake-on-LAN peer selection.
        const body = (await request.json().catch(() => ({}))) as {
          lan?: { subnet_v4?: string; mac?: string; ipv4?: string };
        };

        const nowIso = new Date().toISOString();
        const prevStatus = ctx.device.status;
        const prevSeen = ctx.device.last_seen_at ? new Date(ctx.device.last_seen_at).getTime() : 0;
        const gap = Date.now() - prevSeen;
        const wasOffline = prevStatus !== "online" || gap > RECONNECT_GAP_MS;

        // Merge LAN fingerprint into metadata without clobbering existing keys.
        let mergedMetadata: Record<string, unknown> | undefined;
        if (body.lan && (body.lan.subnet_v4 || body.lan.mac || body.lan.ipv4)) {
          const prevMeta = (ctx.device.metadata ?? {}) as Record<string, unknown>;
          mergedMetadata = {
            ...prevMeta,
            lan_subnet_v4: body.lan.subnet_v4 ?? prevMeta.lan_subnet_v4 ?? null,
            mac: body.lan.mac ?? prevMeta.mac ?? null,
            lan_ipv4: body.lan.ipv4 ?? prevMeta.lan_ipv4 ?? null,
            lan_updated_at: nowIso,
          };
        }

        await ctx.admin
          .from("devices")
          .update({
            status: "online",
            last_seen_at: nowIso,
            ...(mergedMetadata ? { metadata: mergedMetadata as never } : {}),
          })
          .eq("id", ctx.device.id);

        const { data: pending } = await ctx.admin
          .from("sessions")
          .select("id, mode, state")
          .eq("device_id", ctx.device.id)
          .in("state", ["invited", "consented", "active", "paused"])
          .order("created_at", { ascending: false });

        const isSessionActive = (pending ?? []).length > 0;

        // Fetch queued power commands where this device is either
        //   (a) the target of a local action (device_id), OR
        //   (b) the LAN relay peer for a Wake-on-LAN broadcast (relay_device_id).
        const { data: powerRows } = await ctx.admin
          .from("power_commands")
          .select("id, kind, payload, device_id, relay_device_id, expires_at")
          .in("state", ["queued", "dispatched"])
          .or(`device_id.eq.${ctx.device.id},relay_device_id.eq.${ctx.device.id}`)
          .gt("expires_at", nowIso)
          .order("created_at", { ascending: true })
          .limit(8);

        const powerCommands = (powerRows ?? []).map((r) => ({
          id: r.id,
          kind: r.kind,
          payload: r.payload,
          role: r.relay_device_id === ctx.device.id && r.device_id !== ctx.device.id ? "relay" : "target",
        }));

        if (powerCommands.length > 0) {
          const ids = powerCommands.map((c) => c.id);
          await ctx.admin
            .from("power_commands")
            .update({ state: "dispatched", dispatched_at: nowIso })
            .in("id", ids)
            .eq("state", "queued");
        }

        if (wasOffline) {
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
            power_commands: powerCommands,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
