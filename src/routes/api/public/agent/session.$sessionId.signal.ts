import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * WebRTC signaling channel — SDP offer/answer + ICE candidates + "terminated"
 * take-over handshake.
 *
 * Peer-admin isolation is enforced on both sides:
 *   - INSERT policy on session_signals forbids admin rows with a NULL or
 *     mismatched admin_client_id (see 20260728 migration).
 *   - This route:
 *       * validates `kind`, `admin_client_id` shape, and payload byte size,
 *       * for agent POSTs, refuses to stamp an admin_client_id that doesn't
 *         match the session's current binding (agent must only reply to the
 *         admin that owns the peer),
 *       * for agent GETs, filters returned rows to (a) the session's bound
 *         admin_client_id and (b) untargeted broadcasts (NULL) so the agent
 *         doesn't see signals meant for a superseded admin box.
 */
const SIGNAL_KINDS = ["offer", "answer", "ice", "bye", "terminated"] as const;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const MAX_PAYLOAD_BYTES = 32_000;
const JSON_HEADERS = { "content-type": "application/json" };
const errJson = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: code, ...extra }), { status, headers: JSON_HEADERS });

export const Route = createFileRoute("/api/public/agent/session/$sessionId/signal")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return errJson("unauthorized", 401);

        const body = (await request.json().catch(() => ({}))) as {
          kind?: string;
          payload?: unknown;
          admin_client_id?: string | null;
          attempt_id?: string | null;
        };
        const kind = body.kind ?? "";
        if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) {
          return errJson("invalid_kind", 400);
        }
        if (body.payload === undefined || body.payload === null) {
          return errJson("missing_payload", 400);
        }
        let serializedPayload: string;
        try {
          serializedPayload = JSON.stringify(body.payload);
        } catch {
          return errJson("invalid_payload", 400);
        }
        if (serializedPayload.length > MAX_PAYLOAD_BYTES) {
          return errJson("payload_too_large", 413);
        }

        let adminClientId: string | null = null;
        if (body.admin_client_id !== undefined && body.admin_client_id !== null) {
          if (typeof body.admin_client_id !== "string" || !CLIENT_ID_RE.test(body.admin_client_id)) {
            return errJson("invalid_admin_client_id", 400);
          }
          adminClientId = body.admin_client_id;
        }

        let attemptId: string | null = null;
        if (body.attempt_id !== undefined && body.attempt_id !== null) {
          if (typeof body.attempt_id !== "string" || body.attempt_id.length < 4 || body.attempt_id.length > 80) {
            return errJson("invalid_attempt_id", 400);
          }
          attemptId = body.attempt_id;
        }

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state, admin_client_id")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id) {
          return errJson("not_found", 404);
        }
        if (session.state !== "active") {
          return errJson("not_active", 409);
        }
        if (
          adminClientId &&
          session.admin_client_id &&
          adminClientId !== session.admin_client_id
        ) {
          return errJson("admin_client_id_mismatch", 409);
        }

        const { error } = await ctx.admin.from("session_signals").insert({
          session_id: session.id,
          from_side: "agent",
          kind,
          payload: body.payload as never,
          admin_client_id: adminClientId,
          attempt_id: attemptId,
        } as never);
        if (error) {
          // Idempotent retry — the agent's queue will re-post the same
          // attempt_id on transient failures; a duplicate is success.
          if ((error as { code?: string }).code === "23505") {
            return new Response(JSON.stringify({ ok: true, deduped: true }), { headers: JSON_HEADERS });
          }
          return errJson("insert_failed", 500);
        }
        return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
      },

      GET: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return errJson("unauthorized", 401);

        const url = new URL(request.url);
        const since = Number(url.searchParams.get("since") ?? "0") || 0;

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state, admin_client_id")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id) {
          return errJson("not_found", 404);
        }

        let q = ctx.admin
          .from("session_signals")
          .select("id, from_side, kind, payload, admin_client_id")
          .eq("session_id", session.id)
          .eq("from_side", "admin")
          .gt("id", since)
          .order("id", { ascending: true })
          .limit(100);

        // If the session is bound to an admin peer, hide rows meant for a
        // different peer. Untargeted (NULL) broadcasts always pass so the
        // agent can still receive terminate/bye during handoff races.
        if (session.admin_client_id) {
          q = q.or(
            `admin_client_id.eq.${session.admin_client_id},admin_client_id.is.null`,
          );
        }

        const { data, error } = await q;
        if (error) return errJson("query_failed", 500);

        const items = data ?? [];
        const max = items.length ? Number(items[items.length - 1].id) : since;
        return new Response(JSON.stringify({ max, items }), { headers: JSON_HEADERS });
      },
    },
  },
});
