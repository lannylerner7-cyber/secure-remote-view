import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";
import { adminClient } from "@/lib/server-supabase";
import { getIceConfig } from "@/lib/ice.server";

/**
 * ICE configuration for the two native clients (agent + admin console).
 *
 * Lives under /api/public/* because the agent has no Supabase session — but
 * it is NOT anonymous: the caller must present either an enrolled device
 * token (X-Device-Id + X-Device-Token, same check as the other agent routes)
 * or a valid Supabase bearer token (native admin console). TURN credentials
 * are never handed to an unauthenticated caller.
 */
async function authorize(request: Request): Promise<boolean> {
  const device = await verifyDevice(request);
  if (device) return true;

  const auth = request.headers.get("authorization");
  const jwt = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!jwt) return false;
  const { data, error } = await adminClient().auth.getUser(jwt);
  return !error && Boolean(data?.user);
}

export const Route = createFileRoute("/api/public/ice")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await authorize(request))) return new Response("unauthorized", { status: 401 });
        const cfg = await getIceConfig();
        return Response.json(cfg, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
