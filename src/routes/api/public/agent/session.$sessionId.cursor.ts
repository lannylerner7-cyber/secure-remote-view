import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";
import { sessionAuthorized } from "@/lib/authorization.server";

/**
 * Agent → server cursor telemetry (~30 Hz).
 *
 * Body: { x, y, w, h, kind, visible }
 *   x, y      – cursor position in the SAME scaled space as the frame stream
 *   w, h      – dimensions of that scaled space (so admin can map correctly
 *               even if a stale frame with different size is still visible)
 *   kind      – CSS-style cursor label ("default", "text", "pointer", …)
 *   visible   – false when the cursor is hidden by the app (games etc.)
 *
 * Realtime replicates the upsert into `session_cursors` so the admin's SVG
 * overlay glides at native refresh, independent of JPEG frame cadence.
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/cursor")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as {
          x?: number;
          y?: number;
          w?: number;
          h?: number;
          kind?: string;
          visible?: boolean;
        };
        const x = Number.isFinite(body.x) ? Math.trunc(body.x as number) : 0;
        const y = Number.isFinite(body.y) ? Math.trunc(body.y as number) : 0;
        const w = Number.isFinite(body.w) ? Math.trunc(body.w as number) : null;
        const h = Number.isFinite(body.h) ? Math.trunc(body.h as number) : null;
        const kind =
          typeof body.kind === "string" && body.kind.length <= 32 ? body.kind : "default";
        const visible = body.visible !== false;

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        if (session.state !== "active" || !(await sessionAuthorized(ctx.admin, session.id))) {
          return new Response(JSON.stringify({ error: "not_active", state: session.state }), {
            status: 409,
          });
        }

        const { error } = await ctx.admin.from("session_cursors").upsert(
          {
            session_id: session.id,
            x,
            y,
            frame_w: w,
            frame_h: h,
            kind,
            visible,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "session_id" },
        );
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
