import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomBytes } from "crypto";
import { adminClient } from "@/lib/server-supabase";

/**
 * Agent enrollment. Returns a device-scoped token the agent must store
 * (DPAPI on Windows) and present on every subsequent call.
 */
export const Route = createFileRoute("/api/public/agent/enroll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          hostname?: string;
          os?: string;
          displayName?: string;
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
          metadata: { token_hash: tokenHash },
        });
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

        await admin.from("audit_logs").insert({
          event: "device.enrolled",
          detail: { deviceId, hostname: body.hostname },
        });

        return new Response(JSON.stringify({ deviceId, deviceToken: rawToken }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
