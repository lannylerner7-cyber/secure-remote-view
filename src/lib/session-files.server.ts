/**
 * Step 8 — in-session file transfer helpers (server-only).
 *
 * Bytes never touch Postgres: every payload lands in the private
 * `session-files` storage bucket, and the row in `public.session_files` is
 * only the manifest entry. The bucket is private; clients use a JWT-authenticated
 * byte proxy that rechecks session authority instead of signed bearer URLs.
 *
 * The "download selected as .zip" path builds a WinZip AE-2 (AES-256)
 * archive in memory with zip.js — Worker-safe, no native bindings — using the
 * customer's verified account password held in `session_secrets`.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { configure, BlobWriter, BlobReader, ZipWriter } from "@zip.js/zip.js";
import { sessionAuthorized } from "./authorization.server";

export const BUCKET = "session-files";
/** Per-file ceiling, enforced during preparation, byte upload and registration. */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
/** Cumulative per-session ceiling across both directions. */
export const MAX_SESSION_BYTES = 5 * 1024 * 1024 * 1024;

// zip.js spawns web workers by default; the Worker runtime has none.
configure({ useWebWorkers: false });

export function serviceClient(): SupabaseClient<Database> {
  return createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Strip anything that could escape the storage prefix or confuse a zip reader. */
export function safeName(input: string): string {
  const base = (input ?? "file").split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "file").slice(0, 180);
}

export function storagePathFor(sessionId: string, name: string): string {
  const id = crypto.randomUUID();
  return `${sessionId}/${id}-${safeName(name)}`;
}

/**
 * Ownership gate reused by every file server fn: the caller must be the
 * session's technician or a super admin. Returns null when allowed.
 */
export async function assertSessionAccess(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string,
): Promise<"not_found" | "forbidden" | null> {
  const [{ data: session }, { data: isSuper, error: roleError }] = await Promise.all([
    supabase.from("sessions").select("id, technician_id").eq("id", sessionId).maybeSingle(),
    supabase.rpc("has_role", { _user_id: userId, _role: "super_admin" as never }),
  ]);
  if (!session) return "not_found";
  if (session.technician_id !== userId && (roleError || isSuper !== true)) return "forbidden";
  if (!(await sessionAuthorized(supabase, sessionId, "files"))) return "forbidden";
  return null;
}

export async function sessionBytesUsed(
  admin: SupabaseClient<Database>,
  sessionId: string,
): Promise<number> {
  const { data } = await admin
    .from("session_files")
    .select("size_bytes")
    .eq("session_id", sessionId)
    .is("deleted_at", null);
  return (data ?? []).reduce((sum, r) => sum + Number(r.size_bytes ?? 0), 0);
}

// ---- session_secrets: AES-GCM wrapping of the verified customer password --

async function secretKey(): Promise<CryptoKey> {
  const material = process.env.SESSION_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function wrapPassword(plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await secretKey();
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { wrapped: b64(ct), iv: b64(iv.buffer) };
}

export async function unwrapPassword(wrapped: string, iv: string): Promise<string> {
  const key = await secretKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) },
    key,
    unb64(wrapped),
  );
  return new TextDecoder().decode(pt);
}

/**
 * Verify a plaintext password against a real account without minting a
 * durable session: a throwaway publishable client signs in, then signs out.
 */
export async function verifyAccountPassword(email: string, password: string): Promise<boolean> {
  const probe = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await probe.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  try { await probe.auth.signOut(); } catch { /* best effort */ }
  return true;
}

// ---- encrypted zip ---------------------------------------------------------

export async function buildEncryptedZip(
  entries: { name: string; data: Blob }[],
  password: string,
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter("application/zip"), {
    password,
    encryptionStrength: 3, // AES-256 (WinZip AE-2)
    zipCrypto: false,
  });
  const seen = new Map<string, number>();
  for (const entry of entries) {
    let name = safeName(entry.name);
    const hit = seen.get(name) ?? 0;
    seen.set(name, hit + 1);
    if (hit > 0) {
      const dot = name.lastIndexOf(".");
      name = dot > 0 ? `${name.slice(0, dot)} (${hit})${name.slice(dot)}` : `${name} (${hit})`;
    }
    await writer.add(name, new BlobReader(entry.data));
  }
  return (await writer.close()) as Blob;
}
