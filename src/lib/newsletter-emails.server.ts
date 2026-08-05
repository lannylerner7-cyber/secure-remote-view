/**
 * Newsletter welcome email. Server-only.
 *
 * Uses the shared email shell so the header logo, footer logo, legal links and
 * support address are identical to every other message we send.
 */
import { loadSmtpSettings, sendMail } from "./smtp.server";
import { emailShell, emailButton, escapeHtml, SITE, SUPPORT_EMAIL, textFooter } from "./email-shell.server";

const BULLETS: { title: string; body: string }[] = [
  {
    title: "Release notes that matter",
    body: "Agent and admin console updates, what changed, and whether you need to act.",
  },
  {
    title: "Promo drops before they go public",
    body: "Seat pricing changes and limited offers land in your inbox first.",
  },
  {
    title: "Setup and workflow guides",
    body: "Short, practical walkthroughs — enrolling devices, running clean sessions, keeping an audit trail.",
  },
];

export function renderNewsletterWelcome(email: string) {
  const list = BULLETS.map(
    (b) => `<tr>
      <td width="8" style="vertical-align:top;padding:8px 0 0">
        <div style="width:6px;height:6px;border-radius:50%;background:#4F7CFF"></div>
      </td>
      <td style="padding:0 0 14px 12px;font-size:14px;line-height:1.65;color:#374151">
        <strong style="color:#111827">${escapeHtml(b.title)}</strong><br />${escapeHtml(b.body)}
      </td>
    </tr>`,
  ).join("");

  const inner = `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151">
      Thanks for subscribing. You're on the ConnectLive list, which means you'll hear from us when there's
      something genuinely worth reading — not on a schedule for the sake of one.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px">
      ${list}
    </table>

    <div style="margin:22px 0;padding:16px 18px;background:#EFF6FF;border-radius:10px">
      <p style="margin:0;font-size:13px;line-height:1.7;color:#1E3A8A">
        <strong>Ordering soon?</strong> Every completed order ships with the agent installer, the admin console
        installer, your Meeting ID, sign-in details and step-by-step video setup guides. Delivery normally lands
        within 24 hours on business days.
      </p>
    </div>

    ${emailButton(`${SITE}/order`, "See plans and pricing")}

    <p style="margin:0;font-size:13px;line-height:1.7;color:#6b7280">
      Questions, or want a walkthrough before you buy? Just reply to this email — it reaches a real person at
      <a href="mailto:${SUPPORT_EMAIL}" style="color:#4F7CFF;text-decoration:none">${SUPPORT_EMAIL}</a>.
    </p>`;

  const html = emailShell("Welcome to ConnectLive", inner, {
    eyebrow: "Newsletter",
    preheader: "Release notes, promo drops and setup guides — straight from the ConnectLive team.",
    footerNote: `You're receiving this because ${escapeHtml(email)} subscribed on connectliveagent.com. Reply with "unsubscribe" and we'll remove you the same day.`,
  });

  const text = `Welcome to ConnectLive

Thanks for subscribing. You'll hear from us when there's something worth reading:

${BULLETS.map((b) => `- ${b.title}: ${b.body}`).join("\n")}

Every completed order ships with the agent installer, the admin console installer, your Meeting ID, sign-in details and step-by-step video setup guides. Delivery normally lands within 24 hours on business days.

See plans: ${SITE}/order

Questions? Reply to this email or write to ${SUPPORT_EMAIL}.

You're receiving this because ${email} subscribed on connectliveagent.com. Reply with "unsubscribe" and we'll remove you the same day.${textFooter()}`;

  return { subject: "Welcome to ConnectLive", html, text };
}

/** Send the welcome mail. Returns false when SMTP is off or the send failed. */
export async function sendNewsletterWelcome(email: string): Promise<boolean> {
  const settings = await loadSmtpSettings();
  if (!settings) return false;
  const msg = renderNewsletterWelcome(email);
  try {
    await sendMail(settings, { to: email, ...msg });
    return true;
  } catch (err) {
    console.error("[newsletter] welcome send failed", (err as Error).message);
    return false;
  }
}
