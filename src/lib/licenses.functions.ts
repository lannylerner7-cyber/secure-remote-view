import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertStaff(context: { supabase: any; userId: string }, superOnly = false) {
  const { data } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  const roles = ((data ?? []) as Array<{ role: string }>).map((r) => r.role);
  if (superOnly ? !roles.includes("super_admin") : !roles.some((r) => r === "admin" || r === "super_admin")) {
    throw new Error("Forbidden");
  }
}

export type LicenseListRow = {
  id: string;
  meeting_id: string;
  contact_email: string;
  contact_name: string | null;
  company: string | null;
  plan_code: string | null;
  seat_limit: number;
  status: string;
  starts_at: string;
  expires_at: string;
  user_id: string | null;
  seats_used: number;
};

/** Admin: every license with live seat usage. */
export const listLicenses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertStaff(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: licenses, error } = await supabaseAdmin
      .from("licenses")
      .select(
        "id, meeting_id, contact_email, contact_name, company, plan_code, seat_limit, status, starts_at, expires_at, user_id",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const { data: devices } = await supabaseAdmin
      .from("devices")
      .select("id, license_id")
      .not("license_id", "is", null);
    const used = new Map<string, number>();
    for (const d of (devices ?? []) as Array<{ license_id: string }>) {
      used.set(d.license_id, (used.get(d.license_id) ?? 0) + 1);
    }
    return ((licenses ?? []) as Omit<LicenseListRow, "seats_used">[]).map((l) => ({
      ...l,
      seats_used: used.get(l.id) ?? 0,
    }));
  });

/** Admin: devices attached to one license. */
export const listLicenseDevices = createServerFn({ method: "GET" })
  .inputValidator((raw: { license_id: string }) =>
    z.object({ license_id: z.string().uuid() }).parse(raw),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertStaff(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("devices")
      .select("id, device_id, display_name, hostname, os, status, license_state, last_seen_at, enrolled_at")
      .eq("license_id", data.license_id)
      .order("enrolled_at", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

const CreateLicense = z.object({
  contact_email: z.string().email(),
  contact_name: z.string().max(160).optional(),
  company: z.string().max(160).optional(),
  plan_code: z.string().max(64).optional(),
  seat_limit: z.number().int().min(1).max(5000),
  months: z.number().int().min(1).max(60).default(1),
  order_id: z.string().uuid().optional(),
  /** When set, an auth user is created (or reused) and given the customer role. */
  password: z.string().min(8).max(200).optional(),
});

/**
 * Super-admin: provision a customer license (and optionally its portal account).
 * The Meeting ID is minted server-side and is permanent.
 */
export const createLicense = createServerFn({ method: "POST" })
  .inputValidator((raw: z.infer<typeof CreateLicense>) => CreateLicense.parse(raw))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertStaff(context as never, true);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.contact_email.trim().toLowerCase();

    let userId: string | null = null;
    if (data.password) {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: data.password,
        email_confirm: true,
        user_metadata: { display_name: data.contact_name ?? email.split("@")[0] },
      });
      if (createErr && !/already been registered|already exists/i.test(createErr.message)) {
        throw new Error(createErr.message);
      }
      userId = created?.user?.id ?? null;
      if (!userId) {
        const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
        userId = list?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
        if (userId) await supabaseAdmin.auth.admin.updateUserById(userId, { password: data.password });
      }
      if (userId) {
        await supabaseAdmin
          .from("user_roles")
          .upsert({ user_id: userId, role: "customer" as never }, { onConflict: "user_id,role" });
      }
    }

    const { data: mid, error: midErr } = await supabaseAdmin.rpc("generate_meeting_id");
    if (midErr) throw new Error(midErr.message);

    const starts = new Date();
    const expires = new Date(starts);
    expires.setMonth(expires.getMonth() + data.months);

    const { data: license, error } = await supabaseAdmin
      .from("licenses")
      .insert({
        meeting_id: mid as unknown as string,
        user_id: userId,
        contact_email: email,
        contact_name: data.contact_name ?? null,
        company: data.company ?? null,
        plan_code: data.plan_code ?? null,
        seat_limit: data.seat_limit,
        starts_at: starts.toISOString(),
        expires_at: expires.toISOString(),
        created_by: context.userId,
      })
      .select("id, meeting_id, expires_at")
      .single();
    if (error) throw new Error(error.message);

    if (data.order_id) {
      await supabaseAdmin.from("orders").update({ license_id: license.id }).eq("id", data.order_id);
    }
    await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "license.created",
      detail: {
        license_id: license.id,
        meeting_id: license.meeting_id,
        email,
        seats: data.seat_limit,
        months: data.months,
        account_created: Boolean(userId),
      },
    });

    return {
      id: license.id,
      meeting_id: license.meeting_id as string,
      expires_at: license.expires_at as string,
      account_created: Boolean(userId),
    };
  });

const UpdateLicense = z.object({
  id: z.string().uuid(),
  seat_limit: z.number().int().min(1).max(5000).optional(),
  status: z.enum(["active", "suspended", "cancelled"]).optional(),
  extend_months: z.number().int().min(1).max(60).optional(),
  plan_code: z.string().max(64).optional(),
  notes: z.string().max(1000).optional(),
});

/** Super-admin: upgrade seats, extend the term, suspend or restore. */
export const updateLicense = createServerFn({ method: "POST" })
  .inputValidator((raw: z.infer<typeof UpdateLicense>) => UpdateLicense.parse(raw))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertStaff(context as never, true);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: current, error: readErr } = await supabaseAdmin
      .from("licenses")
      .select("expires_at")
      .eq("id", data.id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new Error("License not found");

    const patch: Record<string, unknown> = {};
    if (data.seat_limit !== undefined) patch.seat_limit = data.seat_limit;
    if (data.status !== undefined) patch.status = data.status;
    if (data.plan_code !== undefined) patch.plan_code = data.plan_code;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.extend_months) {
      const base = new Date(current.expires_at);
      const from = base.getTime() > Date.now() ? base : new Date();
      from.setMonth(from.getMonth() + data.extend_months);
      patch.expires_at = from.toISOString();
    }

    const { error } = await supabaseAdmin
      .from("licenses")
      .update(patch as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "license.updated",
      detail: { license_id: data.id, ...(patch as Record<string, never>) },
    });
    return { ok: true };
  });

/** Super-admin: set a new portal password for the license's customer account. */
export const resetCustomerPassword = createServerFn({ method: "POST" })
  .inputValidator((raw: { license_id: string; password: string }) =>
    z
      .object({ license_id: z.string().uuid(), password: z.string().min(8).max(200) })
      .parse(raw),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertStaff(context as never, true);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: license } = await supabaseAdmin
      .from("licenses")
      .select("user_id, contact_email")
      .eq("id", data.license_id)
      .maybeSingle();
    if (!license?.user_id) throw new Error("This license has no portal account yet");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(license.user_id, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "license.password_reset",
      detail: { license_id: data.license_id },
    });
    return { ok: true };
  });
