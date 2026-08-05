/**
 * Contact-form email rendering + delivery. Server-only.
 *
 * Two messages per submission:
 *   1. Support notification -> support@connectliveagent.com, Reply-To set to the
 *      visitor so an admin can answer straight from the inbox.
 *   2. Visitor acknowledgement -> the address they typed, so they have a record.
 */

import { emailShell, escapeHtml, textFooter, SITE, SUPPORT_EMAIL, BRAND } from "./email-shell.server";
import { loadSmtpSettings, sendMail } from "./smtp.server";

export type ContactPayload = {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  message: string;
  source: string;
};

const row = (label: string, value: string) =>
  `<tr>
    <td style="padding:6px 12px 6px 0;font-size:12px;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
    <td style="padding:6px 0;font-size:14px;color:#111827;vertical-align:top">${escapeHtml(value)}</td>
  </tr>`;

export function renderSupportNotification(p: ContactPayload) {
  const ref = p.id.slice(0, 8).toUpperCase();
  const inner = `
<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#374151">
  A new enquiry came in from the website. Reply to this email and it goes straight back to the sender.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
  ${row("Name", p.name)}
  ${row("Email", p.email)}
  ${row("Phone", p.phone?.trim() || "—")}
  ${row("Page", p.source)}
  ${row("Reference", ref)}
</table>
<div style="margin:18px 0 0;padding:14px 16px;background:#f7f9fc;border:1px solid #e5e7eb;border-left:3px solid ${BRAND};border-radius:8px;font-size:14px;line-height:1.7;color:#111827;white-space:pre-wrap">${escapeHtml(
    p.message,
  )}</div>`;

  const text = `New contact enquiry (ref ${ref})

Name:  ${p.name}
Email: ${p.email}
Phone: ${p.phone?.trim() || "—"}
Page:  ${p.source}

${p.message}${textFooter()}`;

  return {
    subject: `New enquiry from ${p.name} — ref ${ref}`,
    html: emailShell(`New enquiry — ref ${ref}`, inner, {
      eyebrow: "Contact form",
      preheader: `${p.name} <${p.email}> — ${p.message.slice(0, 90)}`,
      footerNote: "Internal notification from the ConnectLive website contact form.",
    }),
    text,
  };
}

export function renderVisitorAck(p: ContactPayload) {
  const ref = p.id.slice(0, 8).toUpperCase();
  const first = p.name.trim().split(/\s+/)[0] || "there";
  const inner = `
<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#374151">
  Hi ${escapeHtml(first)} — thanks for reaching out. Your message has been received and the support
  team will join you shortly. We answer inside one business day, usually much sooner.
</p>
<p style="margin:0 0 10px;font-size:13px;color:#6b7280">Here's what you sent us, for your records:</p>
<div style="margin:0 0 18px;padding:14px 16px;background:#f7f9fc;border:1px solid #e5e7eb;border-left:3px solid ${BRAND};border-radius:8px;font-size:14px;line-height:1.7;color:#111827;white-space:pre-wrap">${escapeHtml(
    p.message,
  )}</div>
<p style="margin:0;font-size:13px;line-height:1.7;color:#6b7280">
  Reference <strong style="color:#111827">${ref}</strong>. Just reply to this email to add anything —
  it lands in the same thread.
</p>`;

  const text = `Hi ${first},

Thanks for reaching out. Your message has been received and the support team will join you shortly.

Your message:
${p.message}

Reference: ${ref}
Reply to this email to add anything else.${textFooter()}`;

  return { subject: `We've got your message — ref ${ref}`, html: emailShell("Your message has been received", inner, {
    eyebrow: `Ref ${ref}`,
    preheader: "Support will join you shortly.",
    footerNote: `Sent because you contacted us at ${SITE}/contact.`,
  }), text };
}

export type ContactDelivery = { notified: boolean; acked: boolean };

/** Send both messages. Never throws, never hangs — a mail failure must not lose the enquiry. */
export async function deliverContactEmails(p: ContactPayload): Promise<ContactDelivery> {
  const settings = await loadSmtpSettings();
  if (!settings) return { notified: false, acked: false };

  const notify = async () => {
    const msg = renderSupportNotification(p);
    await sendMail(
      settings,
      { to: SUPPORT_EMAIL, ...msg, replyTo: `${p.name.replace(/[<>"\r\n]/g, "")} <${p.email}>` },
      10_000,
    );
  };

  const ack = async () => {
    const msg = renderVisitorAck(p);
    await sendMail(settings, { to: p.email, ...msg, replyTo: `<${SUPPORT_EMAIL}>` }, 10_000);
  };

  const [notified, acked] = await Promise.allSettled([notify(), ack()]);

  if (notified.status === "rejected")
    console.error("[contact] support notification failed", String(notified.reason));
  if (acked.status === "rejected") console.error("[contact] visitor ack failed", String(acked.reason));

  return { notified: notified.status === "fulfilled", acked: acked.status === "fulfilled" };
}
