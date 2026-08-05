/**
 * Newsletter unsubscribe tokens. Server-only.
 *
 * One-click unsubscribe (RFC 8058) needs a link that works without a session,
 * so the address is carried in the URL and authenticated with an HMAC. The key
 * is the service-role secret, which never leaves the server, so a subscriber
 * cannot forge a token for somebody else's address.
 */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function key(): Promise<CryptoKey> {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "connectlive-newsletter-fallback";
  return crypto.subtle.importKey(
    "raw",
    enc.encode(`newsletter-unsub:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Stable token for an email address. */
export async function unsubToken(email: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await key(), enc.encode(email.trim().toLowerCase()));
  return b64url(new Uint8Array(sig)).slice(0, 32);
}

export async function verifyUnsubToken(email: string, token: string): Promise<boolean> {
  if (!email || !token) return false;
  const expected = await unsubToken(email);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export const SITE_URL = "https://www.connectliveagent.com";

/** Absolute one-click unsubscribe URL for an address. */
export async function unsubUrl(email: string): Promise<string> {
  const t = await unsubToken(email);
  return `${SITE_URL}/api/public/newsletter/unsubscribe?e=${encodeURIComponent(email)}&t=${t}`;
}
