import { createFileRoute } from "@tanstack/react-router";

/**
 * DEPRECATED — the 6-digit PIN pairing flow has been replaced by silent
 * auto-enrollment via Deployment Key (see /api/public/agent/enroll).
 * Kept as a hard 410 so older agent builds fail loudly instead of hanging.
 */
export const Route = createFileRoute("/api/public/agent/pair")({
  server: {
    handlers: {
      POST: async () =>
        new Response(
          JSON.stringify({
            error: "gone",
            message:
              "Pairing codes are no longer supported. Update the ConnectLive agent to a build that auto-enrolls with a Deployment Key.",
          }),
          { status: 410, headers: { "content-type": "application/json" } },
        ),
    },
  },
});
