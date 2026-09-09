import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Send a Telegram notification using the caller's own bot token + chat id
 * stored in admin_settings. RLS scopes reads to auth.uid(), so a technician
 * can never fire another technician's bot.
 */
export const sendTelegramNotify = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { kind: "session_start" | "control_taken" | "control_released" | "session_end" | "device_offline" | "agent_stopped"; text: string }) => data)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: settings } = await supabase
      .from("admin_settings")
      .select("telegram_bot_token, telegram_chat_id, notify_on_session_start, notify_on_control_taken, notify_on_device_offline, notify_on_agent_stopped")
      .maybeSingle();

    if (!settings?.telegram_bot_token || !settings?.telegram_chat_id) {
      return { ok: false, reason: "not_configured" as const };
    }
    if (data.kind === "session_start" && !settings.notify_on_session_start) return { ok: false, reason: "muted" as const };
    if ((data.kind === "control_taken" || data.kind === "control_released") && !settings.notify_on_control_taken) return { ok: false, reason: "muted" as const };
    if (data.kind === "device_offline" && !settings.notify_on_device_offline) return { ok: false, reason: "muted" as const };
    if (data.kind === "agent_stopped" && !settings.notify_on_agent_stopped) return { ok: false, reason: "muted" as const };

    try {
      const res = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: settings.telegram_chat_id,
          text: data.text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, reason: "provider_error" as const, status: res.status, body };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "network_error" as const, message: e instanceof Error ? e.message : "unknown" };
    }
  });
