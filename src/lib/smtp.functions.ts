import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ENCRYPTIONS = ["none", "starttls", "ssl"] as const;

async function assertSuperAdmin(context: {
  supabase: { from: (t: string) => any };
  userId: string;
}) {
  const { data } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}

/** Super-admin: read SMTP settings. The password is never returned — only a flag. */
export const getSmtpSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { envSmtpSettings } = await import("./smtp.server");
    const { data } = await supabaseAdmin
      .from("smtp_settings")
      .select(
        "host, port, username, password, from_name, from_address, reply_to, encryption, enabled, updated_at",
      )
      .eq("id", true)
      .maybeSingle();
    const row = (data ?? {}) as Record<string, unknown>;
    const builtin = envSmtpSettings();
    const customUsable = Boolean(row.enabled && row.host && row.from_address);
    return {
      host: (row.host as string) ?? "",
      port: (row.port as number) ?? 587,
      username: (row.username as string) ?? "",
      has_password: Boolean(row.password),
      from_name: (row.from_name as string) ?? "ConnectLive",
      from_address: (row.from_address as string) ?? "",
      reply_to: (row.reply_to as string) ?? "",
      encryption: ((row.encryption as string) ?? "starttls") as (typeof ENCRYPTIONS)[number],
      enabled: Boolean(row.enabled),
      updated_at: (row.updated_at as string) ?? null,
      active_source: (customUsable ? "custom" : builtin ? "builtin" : "none") as
        | "custom"
        | "builtin"
        | "none",
      builtin_from: builtin?.from_address ?? "",
      builtin_host: builtin?.host ?? "",
    };
  });


const SaveInput = z.object({
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255),
  /** Omit or leave empty to keep the stored password. */
  password: z.string().max(512).optional(),
  from_name: z.string().max(120),
  from_address: z.string().max(255),
  reply_to: z.string().max(255),
  encryption: z.enum(ENCRYPTIONS),
  enabled: z.boolean(),
});

/** Super-admin: save SMTP settings. */
export const saveSmtpSettings = createServerFn({ method: "POST" })
  .inputValidator((raw: z.infer<typeof SaveInput>) => SaveInput.parse(raw))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const patch = {
      host: data.host.trim(),
      port: data.port,
      username: data.username.trim(),
      from_name: data.from_name.trim(),
      from_address: data.from_address.trim().toLowerCase(),
      reply_to: data.reply_to.trim().toLowerCase(),
      encryption: data.encryption,
      enabled: data.enabled,
      updated_at: new Date().toISOString(),
      updated_by: context.userId,
      ...(data.password && data.password.length > 0 ? { password: data.password } : {}),
    };

    const { error } = await supabaseAdmin.from("smtp_settings").update(patch).eq("id", true);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "smtp.settings_saved",
      detail: { host: data.host.trim(), enabled: data.enabled, encryption: data.encryption },
    });
    return { ok: true };
  });

/** Super-admin: send a test message to any address using the saved settings. */
export const sendSmtpTest = createServerFn({ method: "POST" })
  .inputValidator((raw: { to: string }) => z.object({ to: z.string().email() }).parse(raw))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { sendMail } = await import("./smtp.server");

    const { data: row } = await supabaseAdmin
      .from("smtp_settings")
      .select(
        "host, port, username, password, from_name, from_address, reply_to, encryption, enabled, updated_at",
      )
      .eq("id", true)
      .maybeSingle();
    if (!row?.host || !row?.from_address) return { ok: false, error: "SMTP is not configured yet" };

    try {
      await sendMail(row as never, {
        to: data.to,
        subject: "ConnectLive SMTP test",
        html: `<p style="font-family:Arial,sans-serif;font-size:14px">Your ConnectLive SMTP relay is working. Sent ${new Date().toUTCString()}.</p>`,
        text: `Your ConnectLive SMTP relay is working. Sent ${new Date().toUTCString()}.`,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Unknown SMTP error" };
    }
  });

/** Admin: recent order email attempts (for the Payments console log panel). */
export const listOrderEmails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { limit?: number } | undefined) =>
    z
      .object({ limit: z.number().int().min(1).max(200).optional() })
      .parse(raw ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("order_emails")
      .select("id, order_id, kind, recipient, status, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 50);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** Admin: re-send an order email by hand. */
export const resendOrderEmail = createServerFn({ method: "POST" })
  .inputValidator((raw: { order_id: string; kind: "order_received" | "order_confirmed" }) =>
    z
      .object({
        order_id: z.string().uuid(),
        kind: z.enum(["order_received", "order_confirmed"]),
      })
      .parse(raw),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as never);
    const { sendOrderEmailById } = await import("./order-emails.server");
    return sendOrderEmailById(data.kind, data.order_id);
  });
