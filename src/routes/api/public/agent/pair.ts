import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

/**
 * Agent posts the 6-digit pairing code the user typed on the "Join" screen.
 * Server finds a pending session with that code, attaches this device, and
 * flips the session to active. Idempotent — an already-attached matching
 * session returns 200 so agent reconnects survive.
 */
export const Route = createFileRoute("/api/public/agent/pair")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as { code?: string };
        const code = (body.code ?? "").trim();
        if (!/^\d{6}$/.test(code)) {
          return new Response(JSON.stringify({ error: "invalid_code" }), { status: 400 });
        }

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("*")
          .eq("pairing_code", code)
          .in("state", ["invited", "active", "paused"])
          .maybeSingle();

        if (!session) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        if (session.device_id && session.device_id !== ctx.device.id) {
          return new Response(JSON.stringify({ error: "code_in_use" }), { status: 409 });
        }

        const { data: updated, error } = await ctx.admin
          .from("sessions")
          .update({
            device_id: ctx.device.id,
            state: "active",
            consent_at: session.consent_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", session.id)
          .select()
          .single();
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

        await ctx.admin.from("audit_logs").insert({
          device_id: ctx.device.id,
          session_id: session.id,
          event: "session.paired",
          detail: { code },
        });

        return new Response(
          JSON.stringify({ ok: true, sessionId: updated.id, mode: updated.mode, state: updated.state }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
