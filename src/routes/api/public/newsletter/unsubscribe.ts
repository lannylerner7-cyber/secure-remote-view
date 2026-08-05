/**
 * One-click newsletter unsubscribe (RFC 8058).
 *
 * GET  — the link in the email footer; flips the row and renders a small page.
 * POST — what Gmail/Apple Mail call for the List-Unsubscribe-Post header.
 *
 * Public by design: the address is authenticated by an HMAC token, so no
 * session is needed and nobody can unsubscribe an address they were not sent.
 */
import { createFileRoute } from "@tanstack/react-router";
import { verifyUnsubToken } from "@/lib/newsletter-unsub.server";

async function unsubscribe(email: string, token: string): Promise<boolean> {
  if (!(await verifyUnsubToken(email, token))) return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("newsletter_subscribers")
    .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() })
    .eq("email", email.trim().toLowerCase());
  return !error;
}

function page(title: string, body: string, status: number) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" /><title>${title} — ConnectLive</title></head>
<body style="margin:0;background:#0B1220;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<div style="max-width:520px;margin:12vh auto;padding:32px;background:#111c33;border:1px solid #1f2f52;border-radius:16px">
<h1 style="margin:0 0 12px;font-size:20px;color:#fff">${title}</h1>
<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#9fb3d9">${body}</p>
<a href="https://www.connectliveagent.com" style="color:#4F7CFF;text-decoration:none;font-size:14px">Back to connectliveagent.com</a>
</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export const Route = createFileRoute("/api/public/newsletter/unsubscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const ok = await unsubscribe(url.searchParams.get("e") ?? "", url.searchParams.get("t") ?? "");
        return ok
          ? page("You're unsubscribed", "That address will not receive any more ConnectLive newsletters. Support and order emails are unaffected.", 200)
          : page("Link not valid", "This unsubscribe link is incomplete or expired. Email support@connectliveagent.com and we'll remove you the same day.", 400);
      },
      POST: async ({ request }) => {
        const url = new URL(request.url);
        let email = url.searchParams.get("e") ?? "";
        let token = url.searchParams.get("t") ?? "";
        if (!email || !token) {
          const body = await request.text().catch(() => "");
          const form = new URLSearchParams(body);
          email = email || form.get("e") || "";
          token = token || form.get("t") || "";
        }
        const ok = await unsubscribe(email, token);
        return new Response(ok ? "unsubscribed" : "invalid", { status: ok ? 200 : 400 });
      },
    },
  },
});
