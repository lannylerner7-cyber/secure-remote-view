import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";
import { evaluateLicense, type LicenseRow } from "@/lib/licensing.server";

/**
 * Called every ~15s by the agent, and every 5-60s by the SYSTEM updater.
 * Returns pending session invites + is_session_active so the updater can
 * revive ConnectLive.exe if it crashed or the user closed it.
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
          // SCOPE:CAPTURE — attached-display inventory for the admin monitor picker.
          monitors?: Array<{
            index?: number;
            device_name?: string;
            label?: string;
            width?: number;
            height?: number;
            x?: number;
            y?: number;
            primary?: boolean;
          }>;
          selected_monitor?: string;
          // SCOPE:CAPTURE — encode capability reported by HwEncoderProbe.
          encoder?: {
            wire_codec?: string;
            hw_h264?: boolean;
            hw_vendor?: string;
            hw_name?: string;
          };
          // S17 step 1 — measured encode cost for this session. Null fields
          // mean "not measured", never "zero".
          encode?: {
            jpeg_ms?: number | null;
            vp8_ms?: number | null;
            cpu_pct?: number | null;
            ws_mb?: number | null;
            peak_width?: number;
            peak_height?: number;
            rung?: number;
          };
          // S14 — assembly version of the running agent, so the fleet's build
          // spread is a number and staged rollout has something to target.
          version?: string;
        };

        const nowIso = new Date().toISOString();
        const prevStatus = ctx.device.status;
        const prevSeen = ctx.device.last_seen_at ? new Date(ctx.device.last_seen_at).getTime() : 0;
        const gap = Date.now() - prevSeen;
        const wasOffline = prevStatus !== "online" || gap > RECONNECT_GAP_MS;

        // Merge LAN fingerprint + monitor inventory into metadata without
        // clobbering existing keys. Both are best-effort telemetry: a heartbeat
        // that omits them must never erase what we already know.
        let mergedMetadata: Record<string, unknown> | undefined;
        const prevMeta = (ctx.device.metadata ?? {}) as Record<string, unknown>;
        if (body.lan && (body.lan.subnet_v4 || body.lan.mac || body.lan.ipv4)) {
          mergedMetadata = {
            ...prevMeta,
            lan_subnet_v4: body.lan.subnet_v4 ?? prevMeta.lan_subnet_v4 ?? null,
            mac: body.lan.mac ?? prevMeta.mac ?? null,
            lan_ipv4: body.lan.ipv4 ?? prevMeta.lan_ipv4 ?? null,
            lan_updated_at: nowIso,
          };
        }
        if (Array.isArray(body.monitors) && body.monitors.length > 0) {
          // Cap + normalise so a malformed agent payload can't bloat the row.
          const monitors = body.monitors.slice(0, 8).map((m, i) => ({
            index: typeof m.index === "number" ? m.index : i,
            device_name: String(m.device_name ?? `\\\\.\\DISPLAY${i + 1}`).slice(0, 64),
            label: String(m.label ?? `Display ${i + 1}`).slice(0, 96),
            width: typeof m.width === "number" ? m.width : 0,
            height: typeof m.height === "number" ? m.height : 0,
            x: typeof m.x === "number" ? m.x : 0,
            y: typeof m.y === "number" ? m.y : 0,
            primary: m.primary === true,
          }));
          mergedMetadata = {
            ...(mergedMetadata ?? prevMeta),
            monitors,
            selected_monitor:
              typeof body.selected_monitor === "string" && body.selected_monitor.length > 0
                ? body.selected_monitor.slice(0, 64)
                : (monitors.find((m) => m.primary)?.device_name ?? monitors[0]!.device_name),
            monitors_updated_at: nowIso,
          };
        }

        // SCOPE:CAPTURE — encode capability. Same merge discipline as the two
        // blocks above: an older agent that never sends `encoder` must not
        // erase what a newer build already reported.
        if (body.encoder && typeof body.encoder === "object") {
          const e = body.encoder;
          const vendor = typeof e.hw_vendor === "string" ? e.hw_vendor.slice(0, 16) : "none";
          mergedMetadata = {
            ...(mergedMetadata ?? prevMeta),
            encoder: {
              wire_codec: typeof e.wire_codec === "string" ? e.wire_codec.slice(0, 16) : "VP8",
              hw_h264: e.hw_h264 === true,
              hw_vendor: vendor,
              hw_name: typeof e.hw_name === "string" ? e.hw_name.slice(0, 128) : "",
            },
            encoder_updated_at: nowIso,
          };
        }

        // S17 step 1 — measured encode cost. This is the fleet-wide answer to
        // "is software VP8 the wall?", so it must survive the heartbeat rather
        // than living only in one technician's agent log. Numbers are clamped
        // and non-finite values dropped: a malformed payload must not poison
        // the row. Null stays null — "not measured" is not "zero".
        if (body.encode && typeof body.encode === "object") {
          const en = body.encode;
          const num = (v: unknown, max: number): number | null =>
            typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null;
          mergedMetadata = {
            ...(mergedMetadata ?? prevMeta),
            encode: {
              jpeg_ms: num(en.jpeg_ms, 100_000),
              vp8_ms: num(en.vp8_ms, 100_000),
              cpu_pct: num(en.cpu_pct, 10_000),
              ws_mb: num(en.ws_mb, 1_000_000),
              peak_width: num(en.peak_width, 32_768) ?? 0,
              peak_height: num(en.peak_height, 32_768) ?? 0,
              rung: num(en.rung, 64) ?? 0,
            },
            encode_updated_at: nowIso,
          };
        }



        // S14 — agent build version. Same merge discipline: an agent that
        // predates this field must not blank out a version we already know.
        if (typeof body.version === "string" && body.version.length > 0) {
          mergedMetadata = {
            ...(mergedMetadata ?? prevMeta),
            agent_version: body.version.slice(0, 32),
            agent_version_updated_at: nowIso,
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

        // ---- Licence gate -----------------------------------------------
        // A blocked/expired device keeps heartbeating (so it wakes the moment
        // a seat frees) but is handed no sessions and captures nothing.
        let license: LicenseRow | null = null;
        if (ctx.device.license_id) {
          const { data } = await ctx.admin
            .from("licenses")
            .select("id, meeting_id, seat_limit, status, starts_at, expires_at")
            .eq("id", ctx.device.license_id)
            .maybeSingle();
          license = (data as LicenseRow | null) ?? null;
        }
        const verdict = await evaluateLicense(ctx.admin as never, license, ctx.device.id);
        if (verdict.state !== ctx.device.license_state) {
          await ctx.admin
            .from("devices")
            .update({ license_state: verdict.state })
            .eq("id", ctx.device.id);
        }
        const licensed = verdict.state === "active";

        // Only surface the newest live session for this device. If admins
        // stack multiple invites (double-click, take-over across clients),
        // returning them all makes the agent's session loop iterator settle
        // on the OLDEST id — frames then flow to a session no admin is
        // watching and every live view goes black. Auto-end the stragglers.
        const { data: pendingAll } = await ctx.admin
          .from("sessions")
          .select("id, mode, state, created_at")
          .eq("device_id", ctx.device.id)
          .in("state", ["invited", "consented", "active", "paused"])
          .order("created_at", { ascending: false });

        const pending = (pendingAll ?? []).slice(0, 1);
        const staleIds = (pendingAll ?? []).slice(1).map((r) => r.id);
        if (staleIds.length > 0) {
          await ctx.admin
            .from("sessions")
            .update({ state: "ended", ended_at: nowIso })
            .in("id", staleIds);
        }

        const isSessionActive = licensed && pending.length > 0;

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
          role:
            r.relay_device_id === ctx.device.id && r.device_id !== ctx.device.id
              ? "relay"
              : "target",
        }));

        if (licensed && powerCommands.length > 0) {
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
            sessions: licensed ? (pending ?? []) : [],
            power_commands: licensed ? powerCommands : [],
            license: {
              state: verdict.state,
              reason: verdict.reason,
              meeting_id: license?.meeting_id ?? null,
              expires_at: license?.expires_at ?? null,
              seats_used: verdict.seats_used,
              seat_limit: license?.seat_limit ?? null,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
