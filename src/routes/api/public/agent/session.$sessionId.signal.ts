import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * WebRTC signaling channel — SDP offer/answer + ICE candidates.
 *
 *   POST /api/public/agent/session/:id/signal
 *     body: { kind: "offer"|"answer"|"ice"|"bye", payload: any }
 *     Agent posts its side. `from_side` is inferred from device auth (always "agent").
 *
 *   GET  /api/public/agent/session/:id/signal?since=<id>
 *     Response: { max, items: [{ id, from_side: "admin", kind, payload }] }
 *     Agent polls admin-originated signals (agent-originated rows are filtered out).
 *
 * Admin uses Supabase Realtime on `session_signals` directly — it doesn't hit
 * this endpoint. Ownership is enforced against the session's device_id.
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/signal")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as {
          kind?: string;
          payload?: unknown;
        };
        const kind = body.kind ?? "";
        if (!["offer", "answer", "ice", "bye"].includes(kind)) {
          return new Response(JSON.stringify({ error: "invalid_kind" }), { status: 400 });
        }
        if (body.payload === undefined || body.payload === null) {
          return new Response(JSON.stringify({ error: "missing_payload" }), { status: 400 });
        }

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        if (session.state !== "active") {
          return new Response(JSON.stringify({ error: "not_active" }), { status: 409 });
        }

        const { error } = await ctx.admin.from("session_signals").insert({
          session_id: session.id,
          from_side: "agent",
          kind,
          payload: body.payload as never,
        });
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },

      GET: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const url = new URL(request.url);
        const since = Number(url.searchParams.get("since") ?? "0") || 0;

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }

        const { data, error } = await ctx.admin
          .from("session_signals")
          .select("id, from_side, kind, payload")
          .eq("session_id", session.id)
          .eq("from_side", "admin")
          .gt("id", since)
          .order("id", { ascending: true })
          .limit(100);
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

        const items = data ?? [];
        const max = items.length ? Number(items[items.length - 1].id) : since;
        return new Response(JSON.stringify({ max, items }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
