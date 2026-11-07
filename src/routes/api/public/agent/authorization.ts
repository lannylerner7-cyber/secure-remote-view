import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";
import { currentAuthorization, parseAuthorization, parseGrantRequest } from "@/lib/authorization.server";

export const Route = createFileRoute("/api/public/agent/authorization")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (ctx.kind !== "verified") return deviceAuthFailure(ctx);
        try {
          return Response.json({ authorization: await currentAuthorization(ctx.admin, ctx.device.id) },
            { headers: { "cache-control": "no-store" } });
        } catch {
          return new Response("authorization_unavailable", { status: 503 });
        }
      },
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (ctx.kind !== "verified") return deviceAuthFailure(ctx);
        const grant = parseGrantRequest(await request.json().catch(() => null));
        if (!grant) return new Response("invalid_authorization", { status: 400 });
        const { data, error } = await ctx.admin.rpc("record_device_authorization", {
          _device_id: ctx.device.id, _grant: grant,
        });
        const authorization = parseAuthorization(data);
        if (error || !authorization) return new Response("authorization_not_recorded", { status: 503 });
        return Response.json({ ok: true, authorization });
      },
    },
  },
});
