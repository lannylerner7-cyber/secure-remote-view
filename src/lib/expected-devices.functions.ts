import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateClaimCode, normalizePlatform, type Platform } from "@/shared/platform";

/**
 * Expected-devices roster.
 *
 * Windows rows match on hostname (case-insensitive, domain suffix stripped) —
 * a technician knows the machine name in advance.
 * Android rows cannot: phones have no meaningful hostname, so each row carries
 * a one-time pairing code the phone enters during setup. The enroll route
 * stamps `claimed_device_id` when the code is used, which flips the row to
 * "installed". The two mechanisms never overlap: matching is chosen by the
 * row's own `platform`.
 */

function normHost(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .split(".")[0]!;
}

export type ExpectedRow = {
  id: string;
  hostname: string;
  note: string | null;
  platform: Platform;
  claim_code: string | null;
  status: "installed" | "not_installed";
  matched_device_id: string | null;
  last_seen_at: string | null;
  device_status: string | null;
  agent_version: string | null;
};

export const listExpectedDevices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ExpectedRow[]> => {
    const { supabase } = context;
    const [{ data: expected }, { data: devices }] = await Promise.all([
      supabase
        .from("expected_devices")
        .select("id, hostname, note, platform, claim_code, claimed_device_id")
        .order("hostname", { ascending: true }),
      supabase.from("devices").select("id, hostname, status, last_seen_at, metadata"),
    ]);

    type DevInfo = {
      id: string;
      status: string;
      last_seen_at: string | null;
      agent_version: string | null;
    };
    const byHost = new Map<string, DevInfo>();
    const byId = new Map<string, DevInfo>();
    for (const d of devices ?? []) {
      const info: DevInfo = {
        id: d.id,
        status: d.status,
        last_seen_at: d.last_seen_at,
        agent_version:
          ((d.metadata as { agent_version?: string } | null)?.agent_version ?? null) || null,
      };
      byId.set(d.id, info);
      if (d.hostname) byHost.set(normHost(d.hostname), info);
    }

    return (expected ?? []).map((e) => {
      const platform = normalizePlatform(e.platform);
      const match =
        platform === "android"
          ? e.claimed_device_id
            ? (byId.get(e.claimed_device_id) ?? null)
            : null
          : (byHost.get(normHost(e.hostname)) ?? null);
      return {
        id: e.id,
        hostname: e.hostname,
        note: e.note,
        platform,
        claim_code: e.claim_code,
        status: match ? ("installed" as const) : ("not_installed" as const),
        matched_device_id: match?.id ?? null,
        last_seen_at: match?.last_seen_at ?? null,
        device_status: match?.status ?? null,
        agent_version: match?.agent_version ?? null,
      };
    });
  });

export const addExpectedDevices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { hostnames: string[]; note?: string | null; platform?: string }) => data,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const platform = normalizePlatform(data.platform);
    const seen = new Set<string>();
    const rows = data.hostnames
      .map((h) => String(h ?? "").trim())
      .filter((h) => h.length > 0 && h.length <= 253)
      .filter((h) => {
        const key = h.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((h) => ({
        owner_id: userId,
        hostname: h,
        note: data.note ?? null,
        platform,
        claimed_device_id: null,
        claimed_at: null,
        // Windows rows match on hostname and need no code.
        claim_code: platform === "android" ? generateClaimCode() : null,
      }));

    if (rows.length === 0) return { ok: true, inserted: 0 };
    const { error, count } = await supabase
      .from("expected_devices")
      .upsert(rows, { onConflict: "owner_id,hostname", count: "exact" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, inserted: count ?? rows.length };
  });

export const removeExpectedDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("expected_devices")
      .delete()
      .eq("id", data.id);
    return { ok: !error, error: error?.message };
  });

/** Issue a fresh pairing code for an Android roster row (previous code dies). */
export const regenerateClaimCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data, context }) => {
    const code = generateClaimCode();
    const { error } = await context.supabase
      .from("expected_devices")
      .update({ claim_code: code, claimed_device_id: null, claimed_at: null })
      .eq("id", data.id)
      .eq("platform", "android");
    return error ? { ok: false as const, error: error.message } : { ok: true as const, code };
  });
