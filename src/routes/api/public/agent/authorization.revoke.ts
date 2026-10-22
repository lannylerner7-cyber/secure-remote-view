import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

export const Route = createFileRoute("/api/public/agent/authorization/revoke")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });
        const { error } = await ctx.admin.rpc("revoke_device_authorization", { _device_id: ctx.device.id });
        if (error) return new Response("authorization_not_revoked", { status: 503 });
        return Response.json({ ok: true });
      },
    },
  },
});
