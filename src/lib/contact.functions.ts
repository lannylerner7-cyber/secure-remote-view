import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

/**
 * Public contact-form submission.
 *
 * Narrow on purpose: the browser sends only the four form fields plus a source
 * label. Recipients and templates are fixed server-side, so this endpoint can
 * never be used as an open relay. Writes go through the service role because
 * the table has no anon grant.
 */

const Input = z.object({
  name: z.string().trim().min(2, "Tell us your name").max(80),
  email: z.string().trim().toLowerCase().min(5).max(254).email("Enter a valid email"),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  message: z.string().trim().min(10, "A little more detail helps").max(4000),
  source: z.string().trim().max(40).optional(),
});

export type ContactResult = {
  ok: boolean;
  /** "received" | "rate_limited" | "error" */
  status: string;
  message: string;
  reference?: string;
};

async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(`connectlive-contact:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const submitContactMessage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<ContactResult> => {
    const source = data.source?.slice(0, 40) || "contact";
    const phone = data.phone?.trim() || null;

    const ip =
      getRequestHeader("cf-connecting-ip") ||
      getRequestHeader("x-real-ip") ||
      getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const ip_hash = await hashIp(ip);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Rate limit: at most 5 messages per connection per hour.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from("contact_messages")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", since);
    if ((count ?? 0) >= 5) {
      return {
        ok: false,
        status: "rate_limited",
        message: "You've sent a few messages already. Try again in an hour or email support directly.",
      };
    }

    const { data: row, error } = await supabaseAdmin
      .from("contact_messages")
      .insert({ name: data.name, email: data.email, phone, message: data.message, source, ip_hash })
      .select("id")
      .single();

    if (error || !row) {
      return { ok: false, status: "error", message: "We couldn't send that just now. Please try again." };
    }

    const id = (row as { id: string }).id;
    const { deliverContactEmails } = await import("./contact-emails.server");
    const delivery = await deliverContactEmails({
      id,
      name: data.name,
      email: data.email,
      phone,
      message: data.message,
      source,
    });

    const now = new Date().toISOString();
    await supabaseAdmin
      .from("contact_messages")
      .update({
        notified_at: delivery.notified ? now : null,
        ack_sent_at: delivery.acked ? now : null,
      })
      .eq("id", id);

    return {
      ok: true,
      status: "received",
      reference: id.slice(0, 8).toUpperCase(),
      message: "Your message has been received — our support team will join you briefly.",
    };
  });
