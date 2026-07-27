import { createFileRoute } from "@tanstack/react-router";

// Public health endpoint mirror of /health for callers that prefer /api/public/*.
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: () =>
        new Response("OK", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
