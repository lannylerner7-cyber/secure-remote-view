import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";
import { receiveAgentFile } from "@/lib/agent-file-upload.server";

export const Route = createFileRoute("/api/public/agent/session/$sessionId/file")({
  server: { handlers: { POST: async ({ request, params }) => {
    const ctx = await verifyDevice(request);
    if (ctx.kind !== "verified") return deviceAuthFailure(ctx);
    try { return await receiveAgentFile(request, params.sessionId, ctx.admin, ctx.device.id); }
    catch { return Response.json({ ok: false, error: "file_storage_unavailable" }, { status: 503 }); }
  } } },
});
