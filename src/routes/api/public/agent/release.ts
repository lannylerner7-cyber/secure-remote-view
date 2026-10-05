import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { verifyDevice } from "@/lib/agent-auth.server";
import { adminClient } from "@/lib/server-supabase";
import { normalizePlatform, releaseProductFor } from "@/shared/platform";

/**
 * S14 — release manifest.
 *
 * Single source of truth for "what is the newest packaged build?", read by:
 *   - the agent (`agent/src/ApiClient.cs`) after each heartbeat cycle, so a
 *     staged rollout can be driven without touching MDM;
 *   - the native admin console, which shows an update banner;
 *   - `agent/build.ps1` / `admin/build.ps1` operators, who publish a row into
 *     `public.releases` once the zip is uploaded.
 *
 * Rows live in `public.releases` (product = agent|admin, channel =
 * stable|beta). Only `published = true` rows are ever served, and the newest
 * `published_at` wins. Callers authenticate as a device (X-Device-Id +
 * X-Device-Token) or as a technician (Supabase bearer JWT) — download URLs and
 * checksums are not open-internet data.
 *
 * Response shape (204 when nothing is published for that product/channel):
 *   { product, channel, version, download_url, sha256, notes,
 *     min_supported_version, mandatory, published_at }
 */

// agent = Windows agent, android = Android APK, admin = native console.
const PRODUCTS = new Set(["agent", "admin", "android"]);
const CHANNELS = new Set(["stable", "beta"]);

async function verifyTechnician(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!token) return false;
  const url = process.env["SUPABASE_URL"];
  const anon = process.env["SUPABASE_ANON_KEY"] ?? process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !anon) return false;
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  return !error && !!data.user;
}

export const Route = createFileRoute("/api/public/agent/release")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const device = await verifyDevice(request);
        if (!device && !(await verifyTechnician(request))) {
          return new Response("unauthorized", { status: 401 });
        }

        const url = new URL(request.url);
        // A device may only pull its own platform's build: a phone never
        // receives an .exe and a PC never receives an APK.
        const product = device
          ? releaseProductFor(normalizePlatform((device.device as { platform?: string }).platform))
          : (url.searchParams.get("product") ?? "agent");
        const channel = url.searchParams.get("channel") ?? "stable";
        if (!PRODUCTS.has(product) || !CHANNELS.has(channel)) {
          return new Response("bad request", { status: 400 });
        }

        const { data, error } = await adminClient()
          .from("releases")
          .select(
            "product, channel, version, download_url, sha256, notes, min_supported_version, mandatory, published_at",
          )
          .eq("product", product)
          .eq("channel", channel)
          .eq("published", true)
          .order("published_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();

        if (error) return new Response("lookup failed", { status: 500 });
        if (!data) return new Response(null, { status: 204 });

        return Response.json(data, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
