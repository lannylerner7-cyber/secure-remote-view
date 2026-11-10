import { createFileRoute } from "@tanstack/react-router";
import { adminClient } from "@/lib/server-supabase";
import { currentAuthorization, sessionAuthorized } from "@/lib/authorization.server";

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
          .select("id, device_id, technician_id, authorization_id").eq("id", params.sessionId).maybeSingle();
        if (error) return new Response("session_lookup_unavailable", { status: 503 });
        if (!session) return new Response("not_found", { status: 404 });
        if (session.technician_id !== identity.user.id) {
          const { data: superAdmin, error: roleError } = await admin.rpc("has_role", {
            _user_id: identity.user.id, _role: "super_admin",
          });
          if (roleError || superAdmin !== true) return new Response("forbidden", { status: 403 });
        }
        const capabilities = { view: false, control: false, clipboard: false, files: false, recording: false };
        if (!session.device_id || !session.authorization_id)
          return json({ allowed: false, capabilities, authorizationId: null });
        try {
          const grant = await currentAuthorization(admin, session.device_id);
          if (!grant || grant.revokedAt !== null || grant.id !== session.authorization_id)
            return json({ allowed: false, capabilities, authorizationId: null });
          // Grants are immutable snapshots: changing capabilities revokes the
          // old ID and creates a new one. In session_authorized, clipboard,
          // files and recording share the view predicate plus that snapshot's
          // capability bit. Control additionally requires CURRENT control mode.
          // Revalidate after reading the grant, without seven redundant RPCs
          // competing for the same three-second recording request budget.
          // Nothing is cached across requests or lease renewals.
          let unavailable = false;
          const failed = () => { unavailable = true; };
          const [view, control] = await Promise.all([
            sessionAuthorized(admin, session.id, "view", failed),
            grant.capabilities.control ? sessionAuthorized(admin, session.id, "control", failed) : false,
          ]);
          if (unavailable) return new Response("authorization_unavailable", { status: 503 });
          if (!view) return json({ allowed: false, capabilities, authorizationId: null });
          return json({ allowed: true,
            capabilities: { ...grant.capabilities, view: true, control },
            authorizationId: grant.id });
        } catch {
          return new Response("authorization_unavailable", { status: 503 });
        }
      },
    },
  },
});
