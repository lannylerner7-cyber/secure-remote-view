import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Agent polls this endpoint for queued admin input events.
 * GET /api/public/agent/session/:id/inputs?since=<lastId>
 * Response: { max: number, items: Array<{ id, kind, payload }> }
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/inputs")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const url = new URL(request.url);
        const since = Number(url.searchParams.get("since") ?? "0") || 0;

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state, mode")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        // Only relay when the admin has explicitly taken control.
        if (session.state !== "active" || session.mode !== "control") {
          return new Response(JSON.stringify({ max: since, items: [] }), {
            headers: { "content-type": "application/json" },
          });
        }

        const { data, error } = await ctx.admin
          .from("session_inputs")
          .select("id, kind, payload")
          .eq("session_id", session.id)
          .gt("id", since)
          .order("id", { ascending: true })
          .limit(200);
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
