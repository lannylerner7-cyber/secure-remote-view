import { createFileRoute } from "@tanstack/react-router";
import { adminClient } from "@/lib/server-supabase";
import { CAPABILITIES, currentAuthorization, sessionAuthorized } from "@/lib/authorization.server";

const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });

export const Route = createFileRoute("/api/public/admin/session/$sessionId/authorization")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
        if (!token) return new Response("unauthorized", { status: 401 });
        const admin = adminClient();
        const { data: identity, error: identityError } = await admin.auth.getUser(token);
        if (identityError || !identity.user) return new Response("unauthorized", { status: 401 });
        const { data: session, error } = await admin.from("sessions")
          .select("id, device_id, technician_id").eq("id", params.sessionId).maybeSingle();
        if (error || !session) return new Response("not_found", { status: 404 });
        if (session.technician_id !== identity.user.id) {
          const { data: superAdmin, error: roleError } = await admin.rpc("has_role", {
            _user_id: identity.user.id, _role: "super_admin",
          });
          if (roleError || superAdmin !== true) return new Response("forbidden", { status: 403 });
        }
        const capabilities = { view: false, control: false, clipboard: false, files: false, recording: false };
        if (!session.device_id || !(await sessionAuthorized(admin, session.id)))
          return json({ allowed: false, capabilities, authorizationId: null });
        try {
          const grant = await currentAuthorization(admin, session.device_id);
          if (!grant || grant.revokedAt !== null)
            return json({ allowed: false, capabilities, authorizationId: null });
          for (const cap of CAPABILITIES) capabilities[cap] = await sessionAuthorized(admin, session.id, cap);
          // Last revalidation: a concurrent end/revoke must not create permission.
          if (!capabilities.view || !(await sessionAuthorized(admin, session.id)))
            return json({ allowed: false, capabilities: { view: false, control: false, clipboard: false, files: false, recording: false }, authorizationId: null });
          return json({ allowed: true, capabilities, authorizationId: grant.id });
        } catch {
          return new Response("authorization_unavailable", { status: 503 });
        }
      },
    },
  },
});
