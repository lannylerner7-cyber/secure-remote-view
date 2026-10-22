/**
 * Order email templates + dispatcher. Server-only.
 * Every attempt is logged to public.order_emails so the admin can see
 * sent / skipped / error per order.
 */
import { loadSmtpSettings, sendMail, mailErrorReason } from "./smtp.server";
import { deliverOnce, type DeliveryResult } from "./mail-delivery.server";
import { emailShell, escapeHtml, safeHttpsUrl, textFooter, SITE, BRAND, SUPPORT_EMAIL } from "./email-shell.server";

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

const money = (v: number | string | null | undefined) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
};

/** Branded shell with the ConnectLive logo in both the header and the footer. */
function shell(title: string, inner: string, footerNote: string, preheader?: string) {
  // footerNote is plain text here; escape before handing to the shell (which treats it as HTML).
  return emailShell(title, inner, { eyebrow: "Orders", footerNote: escapeHtml(footerNote), preheader });
}

/** Label/value row. Both are plain text and escaped exactly once here. */
function row(label: string, value: string) {
  return `<tr><td style="padding:6px 8px 6px 0;color:#4b5563;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:13px;text-align:right;font-weight:bold;color:#111827;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`;
}

function cta(href: string, label: string) {
  return `<p style="margin:18px 0"><a href="${escapeHtml(safeHttpsUrl(href))}" style="background:${BRAND};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:700;display:inline-block">${escapeHtml(label)}</a></p>`;
}

const SPAM_NOTE = "Please check your spam / junk folder and mark our address as safe, so the delivery email isn't filtered.";

/**
 * Render an order email. Throws `email_render:*` errors when required data is
 * missing or unsafe (e.g. access_ready without a valid https access_link) —
 * we never tell a customer their access is ready without a working link.
 */
export function renderOrderEmail(kind: OrderEmailKind, o: OrderEmailData) {
  if (!o.id || !/^[A-Za-z0-9-]+$/.test(o.id)) throw new Error("email_render: invalid order id");
  const short = o.id.slice(0, 8).toUpperCase();
  const track = `${SITE}/order/${encodeURIComponent(o.id)}`;
  const plan = (o.plan_name || o.plan_code || "ConnectLive plan").trim();
  // Raw first name — escaped exactly once wherever it lands in HTML (title is escaped by the shell).
  const name = (o.full_name || "").trim().split(/\s+/)[0] || "there";
  const coin = String(o.coin || "").replace(/_/g, " ");
  const coinSym = String(o.coin || "").split("_")[0] ?? "";

  if (kind === "order_received") {
    const table = `<table role="presentation" style="width:100%;border-collapse:collapse;margin:12px 0;table-layout:fixed">
      ${row("Order", `#${short}`)}
      ${row("Plan", plan)}
      ${row("Amount", money(o.amount_usd))}
      ${row("Pay with", coin)}
      ${o.amount_coin ? row("Crypto amount", `${Number(o.amount_coin)} ${coinSym}`) : ""}
      ${o.receive_address ? row("Pay to", o.receive_address) : ""}
      ${o.price_expires_at ? row("Price locked until", new Date(o.price_expires_at).toUTCString()) : ""}
    </table>`;

    const html = shell(
      `Thanks ${name} — your order is received`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">We've recorded your ConnectLive order. Send the exact crypto amount to the address below before the price lock expires.</p>
       ${table}
       ${cta(track, "Track this order")}
       <p style="font-size:13px;color:#4b5563;line-height:1.6;margin:0 0 10px">Once the payment confirms on-chain we'll email you again with delivery details.</p>
       <p style="font-size:13px;line-height:1.6;margin:0;padding:12px;background:#EFF6FF;border-radius:8px;color:#1E3A8A"><strong>Video setup guides are included.</strong> On order completion we send the agent installer, the admin console installer, your Meeting ID and sign-in details, plus step-by-step video setup guides covering installation, device enrollment, and your first live session.</p>`,
      "You're receiving this because an order was placed with this email address.",
      `Order #${short} recorded — send ${o.amount_coin ? `${Number(o.amount_coin)} ${coinSym}` : "payment"} before the price lock expires.`,
    );

    const text = [
      `Thanks ${name} — your ConnectLive order #${short} is received.`,
      ``,
      `Plan: ${plan}`,
      `Amount: ${money(o.amount_usd)}`,
      `Pay with: ${coin}`,
      o.amount_coin ? `Crypto amount: ${Number(o.amount_coin)} ${coinSym}` : "",
      o.receive_address ? `Pay to: ${o.receive_address}` : "",
      o.price_expires_at ? `Price locked until: ${new Date(o.price_expires_at).toUTCString()}` : "",
      ``,
      `Once the payment confirms on-chain we'll email you again with delivery details.`,
      `Video setup guides are included: on order completion we send the agent installer, the admin`,
      `console installer, your Meeting ID and sign-in details, plus step-by-step video setup guides.`,
      ``,
      `Track: ${track}`,
    ]
      .filter((l, i, a) => l !== "" || a[i - 1] !== "")
      .join("\n") + textFooter("You're receiving this because an order was placed with this email address.");

    return { subject: `Your ConnectLive order is received — #${short}`, html, text };
  }

  if (kind === "access_ready") {
    // Hard requirement: a real https link. No fallback to the tracking page.
    if (!o.access_link) throw new Error("email_render: access_ready requires access_link");
    const link = safeHttpsUrl(o.access_link);
    const html = shell(
      `Your ConnectLive access is ready`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 10px">Hi ${escapeHtml(name)}, order <strong>#${short}</strong> (${escapeHtml(plan)}) is now provisioned.</p>
       <p style="font-size:14px;line-height:1.6;margin:0 0 10px">Use the link below to get your agent installer, the admin console installer, your Meeting ID and your sign-in details.</p>
       ${cta(link, "Open your access page")}
       <p style="font-size:12px;color:#4b5563;line-height:1.6;margin:0;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(link)}</p>
       <p style="font-size:13px;line-height:1.6;margin:12px 0 0;padding:12px;background:#EFF6FF;border-radius:8px;color:#1E3A8A"><strong>Video setup guides are included.</strong> The same page carries step-by-step video walkthroughs for installing the agent, enrolling your devices with the Meeting ID, and running your first live session.</p>
       <p style="font-size:13px;color:#4b5563;line-height:1.6;margin:12px 0 0">Keep this link private — it is tied to your order.</p>`,
      "Sent because your ConnectLive order was provisioned.",
      `Order #${short} is provisioned — open your access page for installers and sign-in details.`,
    );

    const text = [
      `Hi ${name},`,
      ``,
      `Your ConnectLive access is ready — order #${short} (${plan}).`,
      ``,
      `Access link: ${link}`,
      `Keep this link private — it is tied to your order.`,
      ``,
      `Video setup guides are included on that page: installation, device enrollment with your`,
      `Meeting ID, and running your first live session.`,
      ``,
      `Order status: ${track}`,
      `Contact: ${SITE}/contact`,
    ].join("\n") + textFooter("Sent because your ConnectLive order was provisioned.");

    return { subject: `Your ConnectLive access is ready — #${short}`, html, text };
  }

  // order_confirmed. Delivery timing deliberately neutral: site copy is inconsistent
  // (24h vs 24–48h vs "well inside 24h"), so no numerical promise is made here.
  const html = shell(
    "Payment confirmed",
    `<p style="font-size:14px;line-height:1.6;margin:0 0 10px">Hi ${escapeHtml(name)}, your payment for order <strong>#${short}</strong> (${escapeHtml(plan)}, ${escapeHtml(money(o.amount_usd))}) is confirmed.</p>
     <p style="font-size:14px;line-height:1.6;margin:0 0 10px"><strong>We're now provisioning your access.</strong> When it's ready we send the agent installer, the admin console installer, your Meeting ID, your portal link and your credentials in a single follow-up email.</p>
     <p style="font-size:13px;line-height:1.6;margin:0 0 10px;padding:12px;background:#EFF6FF;border-radius:8px;color:#1E3A8A"><strong>Video setup guides will be provided on order completion.</strong> That delivery email includes step-by-step video walkthroughs for installing the agent, enrolling your devices, and running your first live session.</p>
     <p style="font-size:13px;line-height:1.6;margin:0 0 10px;padding:12px;background:#FEF3C7;border-radius:8px;color:#7C2D12">${escapeHtml(SPAM_NOTE)}</p>
     ${cta(track, "View order status")}
     <p style="font-size:13px;color:#4b5563;margin:0">Questions? Reply to this email or contact us at <a href="${SITE}/contact" style="color:${BRAND};text-decoration:none">${SITE.replace("https://", "")}/contact</a>.</p>`,
    "Sent because your payment for a ConnectLive order was confirmed. We'll email you again as provisioning progresses.",
    `Payment for order #${short} confirmed — we're provisioning your access now.`,
  );

  const text = [
    `Hi ${name},`,
    ``,
    `Payment confirmed — order #${short} (${plan}, ${money(o.amount_usd)}).`,
    ``,
    `We're now provisioning your access. When it's ready we send the agent installer, the admin`,
    `console installer, your Meeting ID, your portal link and your credentials in a single follow-up email.`,
    `Video setup guides will be provided on order completion.`,
    SPAM_NOTE,
    ``,
    `Order status: ${track}`,
    `Contact: ${SITE}/contact`,
  ].join("\n") + textFooter("Sent because your payment for a ConnectLive order was confirmed.");

  return { subject: `Payment confirmed — ConnectLive order #${short}`, html, text };
}


/**
 * Send one order email and log the outcome. Never throws — order flows must
 * never fail because SMTP is down or unconfigured.
 */
export async function sendOrderEmail(
  kind: OrderEmailKind,
  order: OrderEmailData,
  force = false,
): Promise<DeliveryResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const log = async (status: "sent" | "skipped" | "error", detail?: string) => {
    const result = await supabaseAdmin
      .from("order_emails")
      .insert({
        order_id: order.id,
        kind,
        recipient: order.email,
        status,
        detail: detail ?? null,
      })
      .then(
        (value) => !value.error,
        () => false,
      );
    return result;
  };

  try {
    const settings = await loadSmtpSettings();
    if (!settings) {
      await log("skipped", "no_smtp");
      return { ok: false, reason: "no_smtp" };
    }

    const { subject, html, text } = renderOrderEmail(kind, order);
    const result = await deliverOnce(`order:${order.id}:${kind}:${kind === "access_ready" ? order.access_link : ""}`,
      () => sendMail(settings, { to: order.email, subject, html, text, replyTo: SUPPORT_EMAIL }), force);
    if (!result.duplicate) {
      const logged = await log(result.ok ? "sent" : "error", result.warning ?? result.reason);
      if (!logged) return { ...result, warning: "delivery_log_failed" };
    }
    return result;
  } catch (error) {
    const reason = mailErrorReason(error);
    await log("error", reason);
    return { ok: false, reason };
  }
}

/** Load the fields the templates need and dispatch. Safe to await anywhere. */
export async function sendOrderEmailById(kind: OrderEmailKind, orderId: string, force = false) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "id, email, full_name, plan_code, amount_usd, coin, amount_coin, receive_address, price_expires_at, access_link, status",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) return { ok: false, reason: "order_lookup_failed" };
  if (!data) return { ok: false, reason: "order_not_found" as const };
  if (kind !== "order_received" && data.status !== "paid") return { ok: false, reason: "order_not_paid" };
  if (kind === "access_ready" && !data.access_link) return { ok: false, reason: "access_link_missing" };
  if (kind === "order_received" && !["pending", "detected"].includes(data.status)) {
    return { ok: false, reason: "order_no_longer_pending" };
  }
  const result = await sendOrderEmail(kind, data as unknown as OrderEmailData, force);
  if (result.ok && kind === "access_ready" && result.acceptedAt && data.access_link) {
    const { error: stampError } = await supabaseAdmin.from("orders")
      .update({ access_link_sent_at: result.acceptedAt })
      .eq("id", orderId).eq("access_link", data.access_link);
    if (stampError) return { ...result, warning: "delivery_log_failed" };
  }
  return result;
}
