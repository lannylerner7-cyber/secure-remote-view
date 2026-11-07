import { createFileRoute } from "@tanstack/react-router";
import { handleAgentUnlock } from "@/lib/windows-unlock.server";

export const Route = createFileRoute("/api/public/agent/unlock")({
  server: { handlers: { POST: ({ request }) => handleAgentUnlock(request) } },
});
