import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomBytes } from "crypto";
import { adminClient } from "@/lib/server-supabase";

/**
 * Agent auto-enrollment (deployment-key-free).
 *
 * The Agent POSTs here on first boot with no shared secret. The
 * server mints a random per-device token, stores only its SHA-256 hash in
 * `devices.metadata.token_hash`, and returns { deviceId, deviceToken }.
 * The token is DPAPI-encrypted client-side; subsequent calls authenticate
 * with X-Device-Id + X-Device-Token via src/lib/agent-auth.server.ts.
 *
 * Abuse control: per-IP throttle backed by the login_attempts table.
 * A burst of enrolls from one IP starts backing off after 8 per rolling
 * minute; 20+ within a minute earns a 60 s cool-down (HTTP 429). This is
 * a soft guardrail — the real defence is that a fresh device row is inert
 * until an admin creates a session against it.
 */
export const Route = createFileRoute("/api/public/agent/enroll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          hostname?: string;
          os?: string;
          mac?: string;
          displayName?: string;
          agentVersion?: string;
        };

        const forwarded = request.headers.get("x-forwarded-for") ?? "";
        const ip = forwarded.split(",")[0]?.trim() || "unknown";
        const ipMasked = ip.replace(/\.\d+$/, ".0").replace(/:[0-9a-f]+$/i, ":0");
        const throttleKey = `enroll:${ipMasked}`;

        const admin = adminClient();

        // ---- Per-IP throttle (best-effort, uses login_attempts) --------
        const { data: prior } = await admin
          .from("login_attempts")
          .select("failures,locked_until,updated_at")
          .eq("identifier", throttleKey)
          .maybeSingle();

        const now = Date.now();
        if (prior?.locked_until && new Date(prior.locked_until).getTime() > now) {
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }

        // Reset the counter when the window has rolled over (>60s since last hit).
        const lastHitMs = prior?.updated_at ? new Date(prior.updated_at).getTime() : 0;
        const withinWindow = now - lastHitMs < 60_000;
        const nextCount = withinWindow ? (prior?.failures ?? 0) + 1 : 1;
        const lockUntil = nextCount >= 20 ? new Date(now + 60_000).toISOString() : null;

        await admin.from("login_attempts").upsert(
          {
            identifier: throttleKey,
            failures: nextCount,
            locked_until: lockUntil,
            last_ip: ipMasked,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "identifier" },
        );

        if (lockUntil) {
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }

        // ---- Mint credentials ------------------------------------------
        const deviceId = randomBytes(16).toString("hex");
        const rawToken = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");

        const { error } = await admin.from("devices").insert({
          device_id: deviceId,
          display_name: body.displayName ?? body.hostname ?? "Unnamed device",
          hostname: body.hostname ?? null,
          os: body.os ?? null,
          status: "online",
          last_seen_at: new Date().toISOString(),
          metadata: {
            token_hash: tokenHash,
            enrolled_via: "auto",
            mac: body.mac ?? null,
            agent_version: body.agentVersion ?? null,
          },
        });
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

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
