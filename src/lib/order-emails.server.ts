/**
 * Order email templates + dispatcher. Server-only.
 * Every attempt is logged to public.order_emails so the admin can see
 * sent / skipped / error per order.
 */
import { loadSmtpSettings, sendMail } from "./smtp.server";

const SITE = "https://connectliveagent.com";
const BRAND = "#4F7CFF";

export type OrderEmailKind = "order_received" | "order_confirmed" | "access_ready";

export type OrderEmailData = {
  id: string;
  email: string;
  full_name: string | null;
  plan_code: string;
  plan_name?: string | null;
  amount_usd: number | string;
  coin: string;
  amount_coin: number | string | null;
  receive_address: string | null;
  price_expires_at: string | null;
  /** Present for the access_ready email: the delivery/download link. */
  access_link?: string | null;
};

const money = (v: number | string | null | undefined) =>
  v === null || v === undefined ? "—" : `$${Number(v).toFixed(2)}`;

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function shell(title: string, inner: string, footerNote: string) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
  <div style="background:#0B1220;padding:18px 24px;color:#ffffff;font-size:16px;font-weight:bold">ConnectLive</div>
  <div style="padding:24px">
    <h1 style="margin:0 0 12px;font-size:19px;color:#111827">${escapeHtml(title)}</h1>
    ${inner}
  </div>
  <div style="padding:16px 24px;background:#f9fafb;font-size:12px;color:#6b7280;line-height:1.6">
    ${footerNote}<br/>
    <a href="${SITE}" style="color:${BRAND};text-decoration:none">${SITE.replace("https://", "")}</a>
  </div>
</div></body></html>`;
}

function row(label: string, value: string) {
  return `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:13px;text-align:right;font-weight:bold">${escapeHtml(value)}</td></tr>`;
}

export function renderOrderEmail(kind: OrderEmailKind, o: OrderEmailData) {
  const short = o.id.slice(0, 8).toUpperCase();
  const track = `${SITE}/order/${o.id}`;
  const plan = o.plan_name || o.plan_code;
  const name = (o.full_name || "there").split(" ")[0]!;

  if (kind === "order_received") {
    const table = `<table style="width:100%;border-collapse:collapse;margin:12px 0">
      ${row("Order", `#${short}`)}
      ${row("Plan", plan)}
      ${row("Amount", money(o.amount_usd))}
      ${row("Pay with", o.coin.replace("_", " "))}
      ${o.amount_coin ? row("Crypto amount", `${Number(o.amount_coin)} ${o.coin.split("_")[0]}`) : ""}
      ${o.receive_address ? row("Pay to", o.receive_address) : ""}
      ${o.price_expires_at ? row("Price locked until", new Date(o.price_expires_at).toUTCString()) : ""}
    </table>`;

    const html = shell(
      `Thanks ${escapeHtml(name)} — your order is received`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">We've recorded your ConnectLive order. Send the exact crypto amount to the address below before the price lock expires.</p>
       ${table}
       <p style="margin:18px 0"><a href="${track}" style="background:${BRAND};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px;display:inline-block">Track this order</a></p>
       <p style="font-size:13px;color:#6b7280;line-height:1.6;margin:0 0 10px">Once the payment confirms on-chain we'll email you again with delivery details.</p>
       <p style="font-size:13px;line-height:1.6;margin:0;padding:12px;background:#EFF6FF;border-radius:8px;color:#1E3A8A"><strong>Video setup guides are included.</strong> On order completion we send the agent installer, the admin console installer, your Meeting ID and sign-in details, plus step-by-step video setup guides covering installation, device enrollment, and your first live session.</p>`,
      "You're receiving this because an order was placed with this email address.",

    );

    const text = [
      `Thanks ${name} — your ConnectLive order #${short} is received.`,
      ``,
      `Plan: ${plan}`,
      `Amount: ${money(o.amount_usd)}`,
      `Pay with: ${o.coin}`,
      o.amount_coin ? `Crypto amount: ${Number(o.amount_coin)}` : "",
      o.receive_address ? `Pay to: ${o.receive_address}` : "",
      o.price_expires_at ? `Price locked until: ${new Date(o.price_expires_at).toUTCString()}` : "",
      ``,
      `Track: ${track}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { subject: `Your ConnectLive order is received — #${short}`, html, text };
  }

  if (kind === "access_ready") {
    const link = o.access_link || track;
    const html = shell(
      `Your ConnectLive access is ready`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 10px">Hi ${escapeHtml(name)}, order <strong>#${short}</strong> (${escapeHtml(plan)}) is now provisioned.</p>
       <p style="font-size:14px;line-height:1.6;margin:0 0 10px">Use the link below to get your agent installer, the admin console installer, and your sign-in details.</p>
       <p style="margin:18px 0"><a href="${escapeHtml(link)}" style="background:${BRAND};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px;display:inline-block">Open your access page</a></p>
       <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;word-break:break-all">${escapeHtml(link)}</p>
       <p style="font-size:13px;color:#6b7280;line-height:1.6;margin:12px 0 0">Keep this link private — it is tied to your order.</p>`,
      "Sent because your ConnectLive order was provisioned.",
    );

    const text = [
      `Your ConnectLive access is ready — order #${short} (${plan}).`,
      ``,
      `Access link: ${link}`,
      ``,
      `Order status: ${track}`,
      `Support: ${SITE}/contact`,
    ].join("\n");

    return { subject: `Your ConnectLive access is ready — #${short}`, html, text };
  }

  const html = shell(
    "Payment confirmed",
    `<p style="font-size:14px;line-height:1.6;margin:0 0 10px">Hi ${escapeHtml(name)}, your payment for order <strong>#${short}</strong> (${escapeHtml(plan)}, ${money(o.amount_usd)}) is confirmed.</p>
     <p style="font-size:14px;line-height:1.6;margin:0 0 10px"><strong>Your software and sign-in details arrive within 24–48 hours.</strong> We send the agent installer, the admin console installer, your portal link and your credentials in a single follow-up email.</p>
     <p style="font-size:13px;line-height:1.6;margin:0 0 10px;padding:12px;background:#FEF3C7;border-radius:8px;color:#92400E">Please check your spam / junk folder and mark our address as safe, so the delivery email isn't filtered.</p>
     <p style="margin:18px 0"><a href="${track}" style="background:${BRAND};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px;display:inline-block">View order status</a></p>
     <p style="font-size:13px;color:#6b7280;margin:0">Questions? Reply to this email or contact us at ${SITE}/contact.</p>`,
    "Delivery normally lands well inside 24 hours on business days.",
  );

  const text = [
    `Payment confirmed — order #${short} (${plan}, ${money(o.amount_usd)}).`,
    ``,
    `Your software and sign-in details arrive within 24-48 hours.`,
    `Please check your spam/junk folder and mark our address as safe.`,
    ``,
    `Order status: ${track}`,
    `Support: ${SITE}/contact`,
  ].join("\n");

  return { subject: "Payment confirmed — your ConnectLive access is on the way", html, text };
}

/**
 * Send one order email and log the outcome. Never throws — order flows must
 * never fail because SMTP is down or unconfigured.
 */
export async function sendOrderEmail(
  kind: OrderEmailKind,
  order: OrderEmailData,
): Promise<{ ok: boolean; reason?: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const log = async (status: "sent" | "skipped" | "error", detail?: string) => {
    await supabaseAdmin
      .from("order_emails")
      .insert({
        order_id: order.id,
        kind,
        recipient: order.email,
        status,
        detail: detail ?? null,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  };

  const settings = await loadSmtpSettings();
  if (!settings) {
    await log("skipped", "no_smtp");
    return { ok: false, reason: "no_smtp" };
  }

  const { subject, html, text } = renderOrderEmail(kind, order);
  try {
    await sendMail(settings, { to: order.email, subject, html, text });
    await log("sent");
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    await log("error", message.slice(0, 500));
    return { ok: false, reason: message };
  }
}

/** Load the fields the templates need and dispatch. Safe to await anywhere. */
export async function sendOrderEmailById(kind: OrderEmailKind, orderId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("orders")
    .select(
      "id, email, full_name, plan_code, amount_usd, coin, amount_coin, receive_address, price_expires_at, access_link",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (!data) return { ok: false, reason: "order_not_found" as const };
  return sendOrderEmail(kind, data as unknown as OrderEmailData);
}
