import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Expected-devices roster. Lets a technician list hostnames that should have
 * ConnectLive installed. The list is left-joined against `devices.hostname`
 * (case-insensitive, domain suffix stripped) so the admin sees which
 * expected machines have enrolled and which are still missing the agent.
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
  status: "installed" | "not_installed";
  matched_device_id: string | null;
  last_seen_at: string | null;
  device_status: string | null;
};

export const listExpectedDevices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ExpectedRow[]> => {
    const { supabase } = context;
    const [{ data: expected }, { data: devices }] = await Promise.all([
      supabase
        .from("expected_devices")
        .select("id, hostname, note")
        .order("hostname", { ascending: true }),
      supabase
        .from("devices")
        .select("id, hostname, status, last_seen_at"),
    ]);

    const byHost = new Map<string, { id: string; status: string; last_seen_at: string | null }>();
    for (const d of devices ?? []) {
      if (!d.hostname) continue;
      byHost.set(normHost(d.hostname), {
        id: d.id,
        status: d.status,
        last_seen_at: d.last_seen_at,
      });
    }

    return (expected ?? []).map((e) => {
      const match = byHost.get(normHost(e.hostname));
      return {
        id: e.id,
        hostname: e.hostname,
        note: e.note,
        status: match ? ("installed" as const) : ("not_installed" as const),
        matched_device_id: match?.id ?? null,
        last_seen_at: match?.last_seen_at ?? null,
        device_status: match?.status ?? null,
      };
    });
  });

export const addExpectedDevices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { hostnames: string[]; note?: string | null }) => data)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
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
