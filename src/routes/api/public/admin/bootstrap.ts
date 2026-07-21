import { createFileRoute } from "@tanstack/react-router";
import { adminClient } from "@/lib/server-supabase";

/**
 * ONE-TIME technician bootstrap.
 * Call: POST /api/public/admin/bootstrap
 * Body: { technicianId: "197200", password: "…", displayName?: "…" }
 * Header: X-Bootstrap-Token: <BOOTSTRAP_TOKEN env>
 *
 * Idempotent: if the user already exists, only the role assignment is refreshed.
 */
export const Route = createFileRoute("/api/public/admin/bootstrap")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("x-bootstrap-token");
        if (!token || token !== process.env.BOOTSTRAP_TOKEN) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        let body: { technicianId?: string; password?: string; displayName?: string };
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "bad_json" }), { status: 400 });
        }

        if (!body.technicianId || !body.password || body.password.length < 6) {
          return new Response(JSON.stringify({ error: "invalid_input" }), { status: 400 });
        }

        const email = `tech-${body.technicianId}@connectlive.internal`;
        const admin = adminClient();

        // Look up existing user
        let userId: string | undefined;
        const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        userId = existing?.users.find((u) => u.email === email)?.id;

        if (!userId) {
          const { data, error } = await admin.auth.admin.createUser({
            email,
            password: body.password,
            email_confirm: true,
            user_metadata: { technician_id: body.technicianId, display_name: body.displayName ?? body.technicianId },
          });
          if (error || !data.user) {
            return new Response(JSON.stringify({ error: error?.message ?? "create_failed" }), { status: 500 });
          }
          userId = data.user.id;
        } else {
          // rotate password on every re-bootstrap call
          await admin.auth.admin.updateUserById(userId, { password: body.password });
        }

        // Assign technician role (idempotent via UNIQUE constraint)
        const { error: roleErr } = await admin
          .from("user_roles")
          .upsert({ user_id: userId, role: "technician" }, { onConflict: "user_id,role" });
        if (roleErr) {
          return new Response(JSON.stringify({ error: roleErr.message }), { status: 500 });
        }

        return new Response(JSON.stringify({ ok: true, userId, email }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
