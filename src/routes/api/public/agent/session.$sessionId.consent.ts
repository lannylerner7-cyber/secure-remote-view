import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";
import { currentAuthorization } from "@/lib/authorization.server";

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

        const body = (await request.json().catch(() => ({}))) as {
          decision?: string; authorizationId?: string; noticeVersion?: number;
        };
        if (!body || !["accept", "decline"].includes(body.decision ?? ""))
          return new Response("invalid_decision", { status: 400 });
        const decision = body.decision;

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("*")
          .eq("id", params.sessionId)
          .eq("device_id", ctx.device.id)
          .maybeSingle();
        if (!session) return new Response("not_found", { status: 404 });

        // State-machine guard: only invited -> active|declined
        if (session.state !== "invited") {
          return new Response(JSON.stringify({ error: "invalid_state", state: session.state }), {
            status: 409,
          });
        }

        const nextState = decision === "accept" ? "active" : "declined";
        let grant = null;
        if (decision === "accept") {
          try {
            grant = await currentAuthorization(ctx.admin, ctx.device.id);
          } catch {
            return new Response("authorization_unavailable", { status: 503 });
          }
          if (!grant || grant.revokedAt !== null || body.noticeVersion !== 1 ||
              body.authorizationId !== grant.id || !grant.capabilities.view ||
              !["view", "control"].includes(session.mode) ||
              (session.mode === "control" && !grant.capabilities.control))
            return new Response("authorization_required", { status: 403 });
        }
        const { data: updated, error: updateError } = await ctx.admin
          .from("sessions")
          .update({
            state: nextState,
            consent_at: decision === "accept" ? new Date().toISOString() : null,
            ended_at: decision === "accept" ? null : new Date().toISOString(),
            authorization_id: grant?.id ?? null,
            authorization_mode: grant?.mode ?? null,
          })
          .eq("id", session.id)
          .eq("device_id", ctx.device.id)
          .eq("state", "invited")
          .select("id")
          .maybeSingle();

        if (updateError) return new Response("consent_update_failed", { status: 500 });
        if (!updated) return new Response("session_changed", { status: 409 });

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
