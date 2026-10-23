/**
 * Shared HTML email chrome. Server-only.
 *
 * One shell for every outbound message so order mail, newsletter mail and any
 * future template share the same header, logo, spacing and footer. Table-based,
 * inline-styled, 600px — the shape that actually survives Outlook, Gmail and
 * Apple Mail. No web fonts, no external CSS, no <style> block.
 */

export const SITE = "https://www.connectliveagent.com";
export const SUPPORT_EMAIL = "support@connectliveagent.com";
export const BRAND = "#315CCB";
export const INK = "#0B1220";

// First-party PNG for Outlook/Gmail compatibility; keep the text wordmark
// readable when a recipient disables remote images.
export const EMAIL_LOGO_URL = "https://connectliveagent.com/connectlive-logo-orb.png";

export const escapeHtml = (v: string) =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Return a normalised https:// URL safe to put in an href, or throw.
 * Rejects javascript:, data:, http:, credentials-in-URL and control chars.
 */
export function safeHttpsUrl(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v || /[\u0000-\u001f\u007f\s]/.test(v)) throw new Error("email_render: invalid link");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("email_render: invalid link");
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname)
    throw new Error("email_render: link must be https");
  return u.toString();
}

/** Same as safeHttpsUrl but returns null instead of throwing. */
export function trySafeHttpsUrl(raw: string | null | undefined): string | null {
  try {
    return safeHttpsUrl(raw);
  } catch {
    return null;
  }
}

export type ShellOptions = {
  /** Small line under the header, e.g. "Order #A1B2C3D4". */
  eyebrow?: string;
  /** Grey note above the footer links. TRUSTED HTML — callers must escape interpolated values. */
  footerNote?: string;
  /** Hidden inbox preview line. */
  preheader?: string;
};

/** Wrap body HTML in the ConnectLive email shell (logo header + branded footer). */
export function emailShell(title: string, inner: string, opts: ShellOptions = {}) {
  const { eyebrow, footerNote, preheader } = opts;
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
${
  preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#ffffff;font-size:1px;line-height:1px;mso-hide:all">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>`
    : ""
}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;padding:24px 12px">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif">

        <!-- header -->
        <tr>
          <td style="background:${INK};padding:18px 24px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="36" style="vertical-align:middle">
                  <img src="${EMAIL_LOGO_URL}" width="32" height="32" alt="ConnectLive logo" style="display:block;width:32px;height:32px;border:0;outline:none;" />
                </td>
                <td style="vertical-align:middle;padding-left:10px">
                  <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.2px">ConnectLive</span>
                  ${
                    eyebrow
                      ? `<br /><span style="color:#9BB4E8;font-size:11px;letter-spacing:1.4px;text-transform:uppercase">${escapeHtml(eyebrow)}</span>`
                      : ""
                  }
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- body -->
        <tr>
          <td style="padding:28px 24px;color:#111827;word-break:break-word;overflow-wrap:anywhere">
            <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:#111827;font-weight:700">${escapeHtml(title)}</h1>
            ${inner}
          </td>
        </tr>

        <!-- footer -->
        <tr>
          <td style="padding:20px 24px;background:#f7f9fc;border-top:1px solid #e5e7eb">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="30" style="vertical-align:top">
                  <img src="${EMAIL_LOGO_URL}" width="26" height="26" alt="ConnectLive logo" style="display:block;width:26px;height:26px;border:0;outline:none;" />
                </td>
                <td style="vertical-align:top;padding-left:10px;font-size:12px;line-height:1.7;color:#4b5563;word-break:break-word;overflow-wrap:anywhere">
                  <strong style="color:#374151">ConnectLive</strong> — authorised remote support for IT teams and enterprise fleets.<br />
                  ${footerNote ? `${footerNote}<br />` : ""}
                  <a href="${SITE}" style="color:${BRAND};text-decoration:none">connectliveagent.com</a>
                  &nbsp;·&nbsp;
                  <a href="${SITE}/privacy" style="color:${BRAND};text-decoration:none">Privacy</a>
                  &nbsp;·&nbsp;
                  <a href="${SITE}/terms" style="color:${BRAND};text-decoration:none">Terms</a>
                  &nbsp;·&nbsp;
                  <a href="${SITE}/refund" style="color:${BRAND};text-decoration:none">Refunds</a>
                  &nbsp;·&nbsp;
                  <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND};text-decoration:none">${SUPPORT_EMAIL}</a>
                  <br />
                  <span style="color:#6b7280">© ${year} ConnectLive. All rights reserved.</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Primary call-to-action button, table-based so Outlook renders it. */
export function emailButton(href: string, label: string) {
  const safe = escapeHtml(safeHttpsUrl(href));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0">
  <tr><td style="background:${BRAND};border-radius:8px">
    <a href="${safe}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

/** Plain-text footer that mirrors the HTML one. */
export function textFooter(note?: string) {
  return `\n\n—\n${note ? `${note}\n` : ""}ConnectLive — authorised remote support for IT teams and enterprise fleets.\nConnectLive · ${SITE}\nSupport: ${SUPPORT_EMAIL}\nPrivacy: ${SITE}/privacy · Terms: ${SITE}/terms · Refunds: ${SITE}/refund\n© ${new Date().getFullYear()} ConnectLive. All rights reserved.`;
}
