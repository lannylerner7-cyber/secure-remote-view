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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(context.userId, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export type PortalAlertSettings = {
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  notify_on_session_start: boolean;
  notify_on_device_offline: boolean;
};

/** Customer portal: read this customer's own alert settings. */
export const getMyAlertSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PortalAlertSettings> => {
    const { data } = await context.supabase
      .from("portal_settings")
      .select(
        "telegram_bot_token, telegram_chat_id, notify_on_session_start, notify_on_device_offline",
      )
      .eq("user_id", context.userId)
      .maybeSingle();

    return (
      (data as PortalAlertSettings | null) ?? {
        telegram_bot_token: null,
        telegram_chat_id: null,
        notify_on_session_start: true,
        notify_on_device_offline: false,
      }
    );
  });

const alertSchema = z.object({
  telegram_bot_token: z.string().trim().max(200).nullable(),
  telegram_chat_id: z.string().trim().max(100).nullable(),
  notify_on_session_start: z.boolean(),
  notify_on_device_offline: z.boolean(),
});

/** Customer portal: save this customer's own Telegram alert settings. */
export const saveMyAlertSettings = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => alertSchema.parse(raw))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("portal_settings").upsert(
      {
        user_id: context.userId,
        telegram_bot_token: data.telegram_bot_token || null,
        telegram_chat_id: data.telegram_chat_id || null,
        notify_on_session_start: data.notify_on_session_start,
        notify_on_device_offline: data.notify_on_device_offline,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Customer portal: send a test Telegram message with the stored credentials. */
export const sendMyTelegramTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("portal_settings")
      .select("telegram_bot_token, telegram_chat_id")
      .eq("user_id", context.userId)
      .maybeSingle();

    const token = data?.telegram_bot_token;
    const chatId = data?.telegram_chat_id;
    if (!token || !chatId) throw new Error("Add your bot token and chat ID first");

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "ConnectLive: Telegram alerts are wired up correctly.",
      }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.description ?? `Telegram rejected the message (${res.status})`);
    }
    return { ok: true };
  });

const bookingSchema = z.object({
  topic: z.string().trim().min(3).max(120),
  preferred_at: z.string().min(1),
  timezone: z.string().trim().min(1).max(64),
  notes: z.string().trim().max(1000).optional(),
});

export type SupportBooking = {
  id: string;
  topic: string;
  preferred_at: string;
  timezone: string;
  notes: string | null;
  status: string;
  created_at: string;
};

/** Customer portal: list this customer's own session requests. */
export const listMyBookings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SupportBooking[]> => {
    const { data } = await context.supabase
      .from("support_bookings")
      .select("id, topic, preferred_at, timezone, notes, status, created_at")
      .eq("user_id", context.userId)
      .order("preferred_at", { ascending: false })
      .limit(20);
    return (data ?? []) as SupportBooking[];
  });

/** Customer portal: request a scheduled support session. */
export const requestSupportSession = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => bookingSchema.parse(raw))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const when = new Date(data.preferred_at);
    if (Number.isNaN(when.getTime())) throw new Error("Pick a valid date and time");

    const { data: license } = await context.supabase
      .from("licenses")
      .select("id, contact_email, meeting_id, company")
      .eq("user_id", context.userId)
      .maybeSingle();

    const email = license?.contact_email ?? context.claims?.email ?? "unknown@connectliveagent.com";

    const { error } = await context.supabase.from("support_bookings").insert({
      user_id: context.userId,
      license_id: license?.id ?? null,
      contact_email: email,
      topic: data.topic,
      preferred_at: when.toISOString(),
      timezone: data.timezone,
      notes: data.notes ?? null,
    });
    if (error) throw new Error(error.message);

    // Best-effort notifications — never fail the booking on these.
    try {
      const { loadSmtpSettings, sendMail } = await import("./smtp.server");
      const settings = await loadSmtpSettings();
      if (settings) {
        await sendMail(settings, {
          to: "support@connectliveagent.com",
          subject: `Session request — ${data.topic}`,
          html: `<p><strong>${email}</strong> requested a support session.</p>
<p>Meeting ID: ${license?.meeting_id ?? "—"}<br/>
When: ${when.toISOString()} (${data.timezone})<br/>
Topic: ${data.topic}</p>
<p>${(data.notes ?? "").replace(/</g, "&lt;")}</p>`,
          text: `${email} requested a support session.\nMeeting ID: ${license?.meeting_id ?? "-"}\nWhen: ${when.toISOString()} (${data.timezone})\nTopic: ${data.topic}\n${data.notes ?? ""}`,
        });
      }
    } catch {
      /* email is best-effort */
    }

    try {
      const { data: cfg } = await context.supabase
        .from("portal_settings")
        .select("telegram_bot_token, telegram_chat_id")
        .eq("user_id", context.userId)
        .maybeSingle();
      if (cfg?.telegram_bot_token && cfg?.telegram_chat_id) {
        await fetch(`https://api.telegram.org/bot${cfg.telegram_bot_token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cfg.telegram_chat_id,
            text: `ConnectLive: session request logged — ${data.topic} at ${when.toISOString()} (${data.timezone}).`,
          }),
        });
      }
    } catch {
      /* telegram is best-effort */
    }

    return { ok: true };
  });
