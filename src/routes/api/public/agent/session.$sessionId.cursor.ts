import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * High-frequency cursor telemetry (~30Hz) — separate from the frame stream so
 * the pointer stays buttery-smooth even when JPEG frames drop or lag.
 * Body: { x:number, y:number, w?:number, h?:number, kind?:string, visible?:boolean }
 * Coords are in the scaled frame space the agent uploads to /frame.
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/cursor")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as {
          x?: number; y?: number; w?: number; h?: number;
          kind?: string; visible?: boolean;
        };
        if (typeof body.x !== "number" || typeof body.y !== "number") {
          return new Response(JSON.stringify({ error: "invalid_point" }), { status: 400 });
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

        const kind = typeof body.kind === "string" ? body.kind.slice(0, 24) : "default";
        const { error } = await ctx.admin.from("session_cursors").upsert(
          {
            session_id: session.id,
            x: Math.round(body.x),
            y: Math.round(body.y),
            frame_w: typeof body.w === "number" ? body.w : null,
            frame_h: typeof body.h === "number" ? body.h : null,
            kind,
            visible: body.visible !== false,
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
