import { emailShell, escapeHtml, textFooter } from "./email-shell.server";

export function renderSmtpTest(source: string) {
  const content = `This is a requested ConnectLive mail test using ${source} settings. Receipt in your inbox verifies this message only, not future deliverability.`;
  return { subject: "ConnectLive SMTP test", html: emailShell("Email configuration test",
    `<p style="font-size:15px;line-height:1.7">${escapeHtml(content)}</p>`,
    { eyebrow: "Administration", preheader: "Requested email configuration test." }), text: content + textFooter() };
}

export function renderSupportBooking(p: { email: string; meeting: string; when: string; timezone: string; topic: string; notes: string }) {
  const body = `${p.email} requested a support session.\nMeeting ID: ${p.meeting}\nPreferred time: ${p.when} (${p.timezone})\nTopic: ${p.topic}\nNotes: ${p.notes}\nThis is a request, not a confirmed booking.`;
  return { subject: `Session request — ${p.topic.replace(/[\r\n]/g, " ").slice(0, 120)}`,
    html: emailShell("Support session requested", `<p style="white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:14px;line-height:1.7">${escapeHtml(body)}</p>`,
      { eyebrow: "Support", preheader: "A customer requested a support appointment." }),
    text: body + textFooter() };
}
