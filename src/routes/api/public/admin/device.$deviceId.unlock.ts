import { createFileRoute } from "@tanstack/react-router";
import { handleAdminUnlock } from "@/lib/windows-unlock.server";

export const Route = createFileRoute("/api/public/admin/device/$deviceId/unlock")({
  server: { handlers: {
    GET: ({ request, params }) => handleAdminUnlock(request, params.deviceId),
    PUT: ({ request, params }) => handleAdminUnlock(request, params.deviceId),
    POST: ({ request, params }) => handleAdminUnlock(request, params.deviceId),
    DELETE: ({ request, params }) => handleAdminUnlock(request, params.deviceId),
  } },
});
