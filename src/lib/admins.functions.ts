import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AppRole = "super_admin" | "admin" | "technician" | "viewer";

export type AdminRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: AppRole | null;
  created_at: string | null;
};

async function assertSuperAdmin(ctx: { supabase: import("@supabase/supabase-js").SupabaseClient; userId: string }) {
  const { data, error } = await ctx.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", ctx.userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export const getMyRole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    const roles = (data ?? []).map((r) => r.role as AppRole);
    // Priority: super_admin > admin > technician > viewer
    const priority: AppRole[] = ["super_admin", "admin", "technician", "viewer"];
    const role = priority.find((p) => roles.includes(p)) ?? null;
    return { role, roles };
  });

export const listAdmins = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminRow[]> => {
    await assertSuperAdmin(context);
    const { data: profiles, error: pErr } = await context.supabase
      .from("profiles")
      .select("id, email, display_name, created_at")
      .order("created_at", { ascending: true });
    if (pErr) throw new Error(pErr.message);
    const { data: roles, error: rErr } = await context.supabase
      .from("user_roles")
      .select("user_id, role");
    if (rErr) throw new Error(rErr.message);
    const roleMap = new Map<string, AppRole>();
    const priority: AppRole[] = ["super_admin", "admin", "technician", "viewer"];
    for (const r of roles ?? []) {
      const prev = roleMap.get(r.user_id);
      const next = r.role as AppRole;
      if (!prev || priority.indexOf(next) < priority.indexOf(prev)) roleMap.set(r.user_id, next);
    }
    return (profiles ?? []).map((p) => ({
      user_id: p.id,
      email: p.email,
      display_name: p.display_name,
      role: roleMap.get(p.id) ?? null,
      created_at: p.created_at,
    }));
  });

export const createAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { email: string; password: string; display_name: string; role: AppRole }) => input)
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context);
    if (!data.email || !data.password || data.password.length < 8) throw new Error("Email and password (min 8 chars) required");
    if (!["super_admin", "admin", "technician", "viewer"].includes(data.role)) throw new Error("Invalid role");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.display_name },
    });
    if (error || !created.user) throw new Error(error?.message ?? "Failed to create user");
    await supabaseAdmin.from("profiles").upsert({ id: created.user.id, email: data.email, display_name: data.display_name });
    const { error: rErr } = await supabaseAdmin.from("user_roles").insert({ user_id: created.user.id, role: data.role });
    if (rErr) throw new Error(rErr.message);
    return { user_id: created.user.id };
  });

export const updateAdminRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string; role: AppRole }) => input)
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context);
    if (data.user_id === context.userId) throw new Error("Cannot change your own role");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
    const { error } = await supabaseAdmin.from("user_roles").insert({ user_id: data.user_id, role: data.role });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string }) => input)
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context);
    if (data.user_id === context.userId) throw new Error("Cannot delete yourself");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
