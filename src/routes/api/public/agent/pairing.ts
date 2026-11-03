import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { adminClient } from "@/lib/server-supabase";
import { parseAuthorization } from "@/lib/authorization.server";
import { hashPairingValue, parsePairingOffer, readPairingJson } from "@/lib/device-pairing.server";
import { normalizePairingCode } from "@/shared/device-pairing";

const inspect = z.object({ action: z.literal("inspect"), code: z.string().max(40) }).strict();
const redeem = z.object({
  action: z.literal("redeem"), code: z.string().max(40), accepted: z.literal(true),
  noticeVersion: z.literal(1), disclosureId: z.string().uuid(),
  requestId: z.string().regex(/^[0-9a-f]{64}$/), tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  hostname: z.string().trim().min(1).max(200), os: z.string().max(200), agentVersion: z.string().max(40),
}).strict();
const schema = z.discriminatedUnion("action", [inspect, redeem]);
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const Route = createFileRoute("/api/public/agent/pairing")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const admin = adminClient();
          // Coolify's trusted proxy must overwrite incoming forwarding headers.
          // A second, code-bound budget also limits repeated attempts regardless of IP.
          const address = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim()
            || request.headers.get("x-real-ip") || "unknown";
          const { data: ipAllowed, error: rateError } = await admin.rpc("consume_pairing_attempt", {
            _bucket: `ip:${hashPairingValue(address)}`,
          });
          if (rateError) return reply({ error: "pairing_unavailable" }, 503);
          if (!ipAllowed) return reply({ error: "rate_limited" }, 429);
          const parsed = schema.safeParse(await readPairingJson(request).catch(() => null));
          if (!parsed.success) return reply({ error: "invalid_request" }, 400);
          const code = normalizePairingCode(parsed.data.code);
          if (!code) return reply({ error: "pairing_unavailable" }, 400);
          const codeHash = hashPairingValue(code);
          const { data: codeAllowed, error: codeRateError } = await admin.rpc("consume_pairing_attempt", {
            _bucket: `code:${codeHash}`,
          });
          if (codeRateError) return reply({ error: "pairing_unavailable" }, 503);
          if (!codeAllowed) return reply({ error: "rate_limited" }, 429);
          if (parsed.data.action === "inspect") {
            const { data, error } = await admin.rpc("inspect_device_pairing", { _code_hash: codeHash });
            if (error) return reply({ error: "pairing_unavailable" }, 503);
            const offer = parsePairingOffer(data);
            return offer ? reply(offer) : reply({ error: "pairing_unavailable" }, 400);
          }
          const input = parsed.data;
          const { data, error } = await admin.rpc("redeem_device_pairing", {
            _code_hash: codeHash, _request_hash: hashPairingValue(input.requestId),
            _token_hash: input.tokenHash, _disclosure_id: input.disclosureId,
            _hostname: input.hostname, _os: input.os, _agent_version: input.agentVersion,
          });
          if (error) {
            if (error.message === "pairing_seats_full") return reply({ error: "pairing_seats_full" }, 409);
            return reply({ error: "pairing_unavailable" }, error.code === "P0001" ? 409 : 503);
          }
          if (!data || typeof data !== "object" || Array.isArray(data)) return reply({ error: "pairing_unavailable" }, 503);
          const result = data as Record<string, unknown>;
          const authorization = parseAuthorization(result.authorization);
          if (typeof result.deviceId !== "string" || !z.string().uuid().safeParse(result.deviceId).success ||
            !authorization || authorization.revokedAt !== null) return reply({ error: "pairing_unavailable" }, 503);
          return reply({ deviceId: result.deviceId, authorization });
        } catch {
          // Never log pairing codes, tokens, request bodies or DB credentials.
          return reply({ error: "pairing_unavailable" }, 503);
        }
      },
    },
  },
});
