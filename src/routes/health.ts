import { createFileRoute } from "@tanstack/react-router";

// Lightweight liveness probe for Docker / Coolify. No auth, no DB.
export const Route = createFileRoute("/health")({
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
