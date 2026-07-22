import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type NotificationSeverity = "info" | "success" | "warning" | "critical";

export type NotificationRow = {
  id: string;
  recipient_id: string | null;
  sender_id: string | null;
  title: string;
  body: string;
  severity: NotificationSeverity;
  created_at: string;
  read_at: string | null;
};

async function assertSuperAdmin(ctx: {
  supabase: import("@supabase/supabase-js").SupabaseClient;
  userId: string;
}) {
  const { data, error } = await ctx.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", ctx.userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

/** Super-admin: broadcast to every admin (single row, recipient_id NULL). */
export const broadcastNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { title: string; body?: string; severity?: NotificationSeverity }) => input,
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context);
    const title = data.title.trim().slice(0, 200);
    const body = (data.body ?? "").trim().slice(0, 2000);
    if (!title) throw new Error("Title required");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("notifications").insert({
      recipient_id: null,
      sender_id: context.userId,
      title,
      body,
      severity: data.severity ?? "info",
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Super-admin: direct notification to a single admin. */
export const sendNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      recipient_id: string;
      title: string;
      body?: string;
      severity?: NotificationSeverity;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("notifications").insert({
      recipient_id: data.recipient_id,
      sender_id: context.userId,
      title: data.title.trim().slice(0, 200),
      body: (data.body ?? "").trim().slice(0, 2000),
      severity: data.severity ?? "info",
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
