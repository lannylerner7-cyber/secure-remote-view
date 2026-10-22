import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";
import { inputCapability, sessionAuthorized } from "@/lib/authorization.server";

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
        const { data, error } = await ctx.admin
          .from("session_inputs")
          .select("id, kind, payload")
          .eq("session_id", session.id)
          .gt("id", since)
          .order("id", { ascending: true })
          .limit(200);
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

        const rows = data ?? [];
        const max = rows.length ? Number(rows[rows.length - 1].id) : since;
        // Normal mouse/keyboard relay only runs during an active control session.
        // Safety cleanup commands must always be delivered, even after the admin
        // has already flipped the session back to view mode or ended it.
        const allowed = {
          view: await sessionAuthorized(ctx.admin, session.id, "view"),
          control: await sessionAuthorized(ctx.admin, session.id, "control"),
          clipboard: await sessionAuthorized(ctx.admin, session.id, "clipboard"),
        };
        const items = rows.filter((row) => {
          const capability = inputCapability(row.kind);
          return capability === "safety" || (capability !== null &&
            capability in allowed && allowed[capability as keyof typeof allowed]);
        });

        return new Response(JSON.stringify({ max, items }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
