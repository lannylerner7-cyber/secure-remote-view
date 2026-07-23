import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Reusable session resume after reboot/network loss.
 *
 * The agent stores the session id + meeting code locally after the first
 * successful join. On startup, the same enrolled device can re-attach to that
 * still-open session without asking the user to type the code again.
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/reconnect")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as { code?: string };
        const code = (body.code ?? "").trim();
        if (code && !/^\d{6}$/.test(code)) {
          return new Response(JSON.stringify({ error: "invalid_code" }), { status: 400 });
        }

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state, mode, pairing_code")
          .eq("id", params.sessionId)
          .maybeSingle();

        if (!session) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        if (session.device_id !== ctx.device.id) {
          return new Response(JSON.stringify({ error: "wrong_device" }), { status: 403 });
        }
        if (session.state === "ended") {
          return new Response(JSON.stringify({ error: "session_ended" }), { status: 409 });
        }
        if (code && session.pairing_code && session.pairing_code !== code) {
          return new Response(JSON.stringify({ error: "code_mismatch" }), { status: 403 });
        }

        const now = new Date().toISOString();
        const { data: updated, error } = await ctx.admin
          .from("sessions")
          .update({
            state: "active",
            mode: "view",
            updated_at: now,
          })
          .eq("id", session.id)
          .select("id, mode, state")
          .single();
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

        await Promise.all([
          ctx.admin
            .from("devices")
            .update({ status: "online", last_seen_at: now })
            .eq("id", ctx.device.id),
          ctx.admin.from("audit_logs").insert({
            device_id: ctx.device.id,
            session_id: session.id,
            event: "session.reconnected",
            detail: { reused_code: Boolean(session.pairing_code) },
          }),
          ctx.admin.from("session_inputs").insert({
            session_id: session.id,
            kind: "curtain_off",
            payload: {} as never,
          }),
        ]);

        return new Response(
          JSON.stringify({ ok: true, sessionId: updated.id, mode: updated.mode, state: updated.state }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});