import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/plans")({
  server: {
    handlers: {
      GET: async () => {
        const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
        try {
          const { readPublicPlanCatalog } = await import("@/lib/public-plan-catalog.server");
          return Response.json({ plans: await readPublicPlanCatalog() }, { headers });
        } catch {
          return Response.json(
            { error: "Current prices are temporarily unavailable. Please try again." },
            { status: 503, headers },
          );
        }
      },
    },
  },
});
