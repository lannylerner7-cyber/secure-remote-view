import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Agent uploads a JPEG screen frame (base64) for a live session.
 * Body: { frame: string /* base64 jpeg *\/, width?: number, height?: number }
 * The admin panel subscribes to the `session_frames` realtime channel and
 * renders the latest frame as an <img> — cheap, robust, works in every browser.
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/frame")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as {
          frame?: string;
          width?: number;
          height?: number;
        };
        if (!body.frame || typeof body.frame !== "string" || body.frame.length > 2_000_000) {
          return new Response(JSON.stringify({ error: "invalid_frame" }), { status: 400 });
        }

        // Ownership check: the session must belong to this device and be live.
        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        if (session.state !== "active") {
          return new Response(JSON.stringify({ error: "not_active", state: session.state }), {
            status: 409,
          });
        }

        const { error } = await ctx.admin.from("session_frames").upsert(
          {
            session_id: session.id,
            frame: body.frame,
            width: body.width ?? null,
            height: body.height ?? null,
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
