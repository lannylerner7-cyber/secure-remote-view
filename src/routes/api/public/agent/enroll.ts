import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { adminClient } from "@/lib/server-supabase";

/**
 * Agent auto-enrollment.
 *
 * Silent Deployment-Key handshake — replaces the old 6-digit PIN flow.
 * The Watcher (or Agent) sends `X-Deployment-Key` on first boot; server
 * verifies against AGENT_DEPLOYMENT_KEY (timing-safe), inserts the device,
 * and returns a permanent per-device token. Subsequent calls authenticate
 * with X-Device-Id + X-Device-Token — the deployment key is never reused.
 */
export const Route = createFileRoute("/api/public/agent/enroll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.AGENT_DEPLOYMENT_KEY;
        if (!expected) {
          return new Response(JSON.stringify({ error: "server_not_configured" }), { status: 503 });
        }

        const provided = request.headers.get("x-deployment-key") ?? "";
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          // Uniform delay to blunt trivial timing/enumeration.
          await new Promise((r) => setTimeout(r, 250));
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }

        const body = (await request.json().catch(() => ({}))) as {
          hostname?: string;
          os?: string;
          mac?: string;
          displayName?: string;
          agentVersion?: string;
        };

        const deviceId = randomBytes(16).toString("hex");
        const rawToken = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");

        const admin = adminClient();
        const { error } = await admin.from("devices").insert({
          device_id: deviceId,
          display_name: body.displayName ?? body.hostname ?? "Unnamed device",
          hostname: body.hostname ?? null,
          os: body.os ?? null,
          status: "online",
          last_seen_at: new Date().toISOString(),
          metadata: {
            token_hash: tokenHash,
            enrolled_via: "deployment_key",
            mac: body.mac ?? null,
            agent_version: body.agentVersion ?? null,
          },
        });
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

        const forwarded = request.headers.get("x-forwarded-for") ?? "";
        const ip = forwarded.split(",")[0]?.trim() || null;
        const ipMasked = ip ? ip.replace(/\.\d+$/, ".0").replace(/:[0-9a-f]+$/i, ":0") : null;

        await admin.from("audit_logs").insert({
          event: "device.auto_enrolled",
          detail: { deviceId, hostname: body.hostname ?? null, ip: ipMasked },
        });

        return new Response(JSON.stringify({ deviceId, deviceToken: rawToken }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
