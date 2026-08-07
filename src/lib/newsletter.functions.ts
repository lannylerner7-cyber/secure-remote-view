import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

/**
 * Public newsletter signup.
 *
 * Deliberately narrow: the browser can submit exactly one thing — an email
 * address — and gets back only "ok" or a reason. No recipient list, no template
 * name, no arbitrary content crosses the boundary, so this endpoint cannot be
 * turned into an open relay. Writes go through the service role because the
 * table has no anon grant at all.
 */

const Input = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(5)
    .max(254)
    .email(),
  source: z.string().trim().max(40).optional(),
});

/** Hash the caller IP — we rate limit on it, we never store it in the clear. */
async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(`connectlive-newsletter:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type SubscribeResult = {
  ok: boolean;
  /** "subscribed" | "already" | "rate_limited" | "invalid" | "mail_pending" */
  status: string;
  message: string;
};

export const subscribeNewsletter = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<SubscribeResult> => {
    const email = data.email;
    const source = data.source?.slice(0, 40) || "homepage";

    const ip =
      getRequestHeader("cf-connecting-ip") ||
      getRequestHeader("x-real-ip") ||
      getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const ip_hash = await hashIp(ip);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Rate limit: at most 5 signups per IP per hour.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from("newsletter_subscribers")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", since);
    if ((count ?? 0) >= 5) {
      return {
        ok: false,
        status: "rate_limited",
        message: "Too many signups from this connection. Try again in an hour.",
      };
    }

    const { data: existing } = await supabaseAdmin
      .from("newsletter_subscribers")
      .select("id, status")
      .eq("email", email)
      .maybeSingle();

    if (existing && (existing as { status: string }).status === "subscribed") {
      return { ok: true, status: "already", message: "You're already on the list — thanks!" };
    }

    if (existing) {
      await supabaseAdmin
        .from("newsletter_subscribers")
        .update({ status: "subscribed", unsubscribed_at: null, ip_hash })
        .eq("id", (existing as { id: string }).id);
    } else {
      const { error } = await supabaseAdmin
        .from("newsletter_subscribers")
        .insert({ email, source, ip_hash });
      if (error) {
        return { ok: false, status: "error", message: "We couldn't save that just now. Try again." };
      }
    }

    const { sendNewsletterWelcome } = await import("./newsletter-emails.server");
    const result = await sendNewsletterWelcome(email);
    if (result.sent) {
      await supabaseAdmin
        .from("newsletter_subscribers")
        .update({ welcome_sent_at: new Date().toISOString() })
        .eq("email", email);
      return { ok: true, status: "subscribed", message: "You're in — check your inbox for a welcome note." };
    }

    // A failed welcome must leave a trace: otherwise the subscriber is stored,
    // the mail never lands, and nothing anywhere says why.
    await supabaseAdmin.from("audit_logs").insert({
      event: "newsletter.welcome_failed",
      detail: { email, reason: result.reason ?? "unknown" },
    });

    return {
      ok: true,
      status: "mail_pending",
      message: "You're subscribed. The welcome email is on its way shortly.",
    };
  });

