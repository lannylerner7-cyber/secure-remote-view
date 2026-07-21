import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * The end-user's answer to the on-screen consent dialog on the device.
 * Body: { decision: "accept" | "decline" }
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/consent")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as { decision?: string };
        const decision = body.decision === "accept" ? "accept" : "decline";

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("*")
          .eq("id", params.sessionId)
          .eq("device_id", ctx.device.id)
          .maybeSingle();
        if (!session) return new Response("not_found", { status: 404 });

        // State-machine guard: only invited -> consented|declined
        if (session.state !== "invited") {
          return new Response(JSON.stringify({ error: "invalid_state", state: session.state }), {
            status: 409,
          });
        }

        const nextState = decision === "accept" ? "active" : "declined";
        await ctx.admin
          .from("sessions")
          .update({
            state: nextState,
            consent_at: decision === "accept" ? new Date().toISOString() : null,
            ended_at: decision === "accept" ? null : new Date().toISOString(),
          })
          .eq("id", session.id);

        await ctx.admin.from("audit_logs").insert({
          session_id: session.id,
          device_id: ctx.device.id,
          event: decision === "accept" ? "session.consent_granted" : "session.consent_declined",
          detail: { mode: session.mode },
        });

        return new Response(JSON.stringify({ ok: true, state: nextState }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
