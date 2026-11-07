import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";
import { sessionAuthorized } from "@/lib/authorization.server";
import { withAgentHttpDiagnostics } from "@/lib/agent-http-diagnostics.server";

/**
 * Agent uploads a JPEG screen frame (base64) for a live session.
 * Body: { frame: string /* base64 jpeg *\/, width?: number, height?: number }
 * The admin panel subscribes to the `session_frames` realtime channel and
 * renders the latest frame as an <img> — cheap, robust, works in every browser.
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/frame")({
  server: {
    handlers: {
      POST: async ({ request, params }) => withAgentHttpDiagnostics(request, "frame", async (trace) => {
        const ctx = await trace.step("device_auth", () => verifyDevice(request));
        if (ctx.kind !== "verified") return trace.respond(deviceAuthFailure(ctx),
          ctx.kind === "unavailable" ? "device_lookup_unavailable" : "unauthorized");

        const body = (await trace.step("request_body", () => request.json().catch(() => ({})))) as {
          frame?: string;
          width?: number;
          height?: number;
        };
        if (!body.frame || typeof body.frame !== "string" || body.frame.length > 2_000_000) {
          return trace.respond(Response.json({ error: "invalid_frame" }, { status: 400 }), "invalid_frame");
        }
        const frame = body.frame;

        // Ownership check: the session must belong to this device and be live.
        const { data: session, error: sessionError } = await trace.step("session_lookup", () => ctx.admin
          .from("sessions")
          .select("id, device_id, state, media_mode")
          .eq("id", params.sessionId)
          .maybeSingle());
        if (sessionError) return trace.respond(
          Response.json({ error: "session_lookup_unavailable" }, { status: 503 }), "session_lookup_unavailable");
        if (!session || session.device_id !== ctx.device.id) {
          return trace.respond(Response.json({ error: "not_found" }, { status: 404 }), "not_found");
        }
        if (session.media_mode === "video") {
          return trace.respond(Response.json({ error: "video_only_session" }, { status: 409 }), "video_only_session");
        }
        if (session.state !== "active") {
          return trace.respond(Response.json({ error: "not_active", state: session.state }, { status: 409 }), "not_active");
        }
        let authorizationUnavailable = false;
        const allowed = await trace.step("session_authorization", () =>
          sessionAuthorized(ctx.admin, session.id, "view", () => { authorizationUnavailable = true; }));
        if (authorizationUnavailable) return trace.respond(
          Response.json({ error: "session_authorization_unavailable" }, { status: 503 }), "session_authorization_unavailable");
        if (!allowed) return trace.respond(
          Response.json({ error: "not_active", state: session.state }, { status: 409 }), "not_active");

        const { error } = await trace.step("frame_write", () => ctx.admin.from("session_frames").upsert(
          {
            session_id: session.id,
            frame,
            width: body.width ?? null,
            height: body.height ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "session_id" },
        ));
        if (error) return trace.respond(
          Response.json({ error: "frame_write_failed" }, { status: 500 }), "frame_write_failed");

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }),
    },
  },
});
