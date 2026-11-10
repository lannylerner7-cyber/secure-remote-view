import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";
import { sessionAuthorized } from "@/lib/authorization.server";
import { isAdminClientId } from "@/shared/signaling-identity";
import { evaluateLicense, type LicenseRow } from "@/lib/licensing.server";

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** A mode read, NOT a mode mutation or a substitute for an enrollment grant.
 * The live Agent can observe an explicit Admin change without waiting for the
 * telemetry-heavy heartbeat. All identities and authority are checked afresh.
 */
export const Route = createFileRoute("/api/public/agent/session/$sessionId/permission")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (ctx.kind !== "verified") return deviceAuthFailure(ctx, "json");
        const query = new URL(request.url).searchParams;
        const mode = query.get("mode"), authorizationId = query.get("authorization_id");
        const controllerId = query.get("admin_client_id"), instance = query.get("instance");
        if (!uuid.test(params.sessionId) || !authorizationId || !uuid.test(authorizationId) ||
            !instance || !uuid.test(instance) || !isAdminClientId(controllerId) ||
            (mode !== "view" && mode !== "control"))
          return reply({ error: "invalid_permission_request" }, 400);
        try {
          const [sessionResult, runtimeResult, licenseResult] = await Promise.all([
            ctx.admin.from("sessions").select("id, device_id, state, mode, authorization_id, admin_client_id")
              .eq("id", params.sessionId).eq("device_id", ctx.device.id).maybeSingle(),
            ctx.admin.from("agent_runtime").select("agent_instance, agent_state")
              .eq("device_id", ctx.device.id).maybeSingle(),
            ctx.device.license_id ? ctx.admin.from("licenses")
              .select("id, meeting_id, seat_limit, status, starts_at, expires_at")
              .eq("id", ctx.device.license_id).maybeSingle() : { data: null, error: null },
          ]);
          if (sessionResult.error || runtimeResult.error || licenseResult.error)
            return reply({ error: "permission_unavailable" }, 503);
          const session = sessionResult.data, runtime = runtimeResult.data;
          if (!runtime || runtime.agent_instance !== instance || runtime.agent_state !== "running")
            return reply({ error: "retired_or_stopped_process" }, 409);
          if (!session || session.state !== "active" || session.mode !== mode ||
              session.authorization_id !== authorizationId || session.admin_client_id !== controllerId)
            return reply({ error: "session_binding_changed" }, 409);
          const license = await evaluateLicense(ctx.admin as never, licenseResult.data as LicenseRow | null, ctx.device.id);
          if (license.state !== "active" && license.state !== "unlicensed")
            return reply({ error: "license_denied" }, 403);
          let unavailable = false;
          const allowed = await sessionAuthorized(ctx.admin, session.id, mode, () => { unavailable = true; });
          if (unavailable) return reply({ error: "permission_unavailable" }, 503);
          if (!allowed) return reply({ error: "permission_denied" }, 403);
          return reply({ sessionId: session.id, authorizationId, adminClientId: controllerId, mode, protocol: 1 });
        } catch { return reply({ error: "permission_unavailable" }, 503); }
      },
    },
  },
});
