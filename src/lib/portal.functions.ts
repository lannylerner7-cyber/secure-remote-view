import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type PortalDevice = {
  id: string;
  device_id: string;
  display_name: string | null;
  hostname: string | null;
  os: string | null;
  status: string;
  license_state: string;
  last_seen_at: string | null;
  enrolled_at: string;
};

export type PortalOverview = {
  license: {
    id: string;
    meeting_id: string;
    contact_email: string;
    company: string | null;
    plan_code: string | null;
    seat_limit: number;
    status: string;
    starts_at: string;
    expires_at: string;
    days_left: number;
    seats_used: number;
  } | null;
  devices: PortalDevice[];
};

/** Customer portal: the signed-in customer's own license + devices. */
export const getMyPortal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PortalOverview> => {
    const { data: license } = await context.supabase
      .from("licenses")
      .select(
        "id, meeting_id, contact_email, company, plan_code, seat_limit, status, starts_at, expires_at",
      )
      .eq("user_id", context.userId)
      .maybeSingle();

    if (!license) return { license: null, devices: [] };

    const { data: devices } = await context.supabase
      .from("devices")
      .select(
        "id, device_id, display_name, hostname, os, status, license_state, last_seen_at, enrolled_at",
      )
      .eq("license_id", license.id)
      .order("enrolled_at", { ascending: true });

    const rows = (devices ?? []) as PortalDevice[];
    const daysLeft = Math.ceil(
      (new Date(license.expires_at).getTime() - Date.now()) / 86_400_000,
    );

    return {
      license: { ...license, days_left: daysLeft, seats_used: rows.length },
      devices: rows,
    };
  });

/** Customer portal: remove one of their own devices, freeing its seat. */
export const removeMyDevice = createServerFn({ method: "POST" })
  .inputValidator((raw: { device_id: string }) =>
    z.object({ device_id: z.string().uuid() }).parse(raw),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { data: license } = await context.supabase
      .from("licenses")
      .select("id")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!license) throw new Error("No license on this account");

    const { error } = await context.supabase
      .from("devices")
      .delete()
      .eq("id", data.device_id)
      .eq("license_id", license.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Customer portal: change the portal password. */
export const changeMyPassword = createServerFn({ method: "POST" })
  .inputValidator((raw: { password: string }) =>
    z.object({ password: z.string().min(8).max(200) }).parse(raw),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.auth.updateUser({ password: data.password });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
