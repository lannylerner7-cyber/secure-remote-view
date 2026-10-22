import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  assertSessionAccess, BUCKET, MAX_FILE_BYTES, MAX_SESSION_BYTES, safeName,
  sessionBytesUsed, buildEncryptedZip, unwrapPassword,
} from "./session-files.server";

export function fileProxyUrl(sessionId: string, query: Record<string, string>) {
  return `/api/public/admin/session/${encodeURIComponent(sessionId)}/files/bytes?${new URLSearchParams(query)}`;
}

/** Storage paths are identifiers, never credentials. No directories/traversal. */
export function validFilePath(sessionId: string, path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith(`${sessionId}/`)) return false;
  const leaf = path.slice(sessionId.length + 1);
  return /^[A-Za-z0-9_-]+-[A-Za-z0-9._ -]{1,180}$/.test(leaf) &&
    !leaf.includes("/") && !leaf.includes("\\") && !leaf.includes("%");
}

const bad = (status: number, error: string) =>
  Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
const attachment = (blob: Blob, name: string) => new Response(blob, {
  headers: {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${safeName(name)}"`,
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
  },
});

export async function registerUploadedFile(
  admin: SupabaseClient<Database>, userId: string,
  input: {
    sessionId: string; path: string; name: string; size: number; mime?: string;
    sha256?: string; direction: string; transport?: string;
  },
) {
  const check = () => assertSessionAccess(admin, userId, input.sessionId);
  if (await check()) return { ok: false as const, error: "forbidden" };
  if (!validFilePath(input.sessionId, input.path)) return { ok: false as const, error: "invalid_path" };
  if (typeof input.name !== "string" || !input.name ||
      (input.mime !== undefined && (typeof input.mime !== "string" || input.mime.length > 256)) ||
      (input.sha256 !== undefined && (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256))))
    return { ok: false as const, error: "invalid_metadata" };
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_FILE_BYTES)
    return { ok: false as const, error: "invalid_size" };
  if (!["from_agent", "from_admin"].includes(input.direction) ||
      !["http", "datachannel"].includes(input.transport ?? "http"))
    return { ok: false as const, error: "invalid_direction_or_transport" };
  // The caller cannot invent a size/manifest for missing or different bytes.
  const { data: blob, error } = await admin.storage.from(BUCKET).download(input.path);
  if (error || !blob) return { ok: false as const, error: "uploaded_file_not_found" };
  if (blob.size !== input.size) return { ok: false as const, error: "size_mismatch" };
  if (await check()) return { ok: false as const, error: "authorization_changed" };
  if (await sessionBytesUsed(admin, input.sessionId) + blob.size > MAX_SESSION_BYTES)
    return { ok: false as const, error: "session_quota_exceeded" };
  const { data: row, error: insertError } = await admin.from("session_files").insert({
    session_id: input.sessionId, storage_path: input.path, name: safeName(input.name),
    size_bytes: blob.size, mime: input.mime || "application/octet-stream",
    sha256: input.sha256 ?? null, direction: input.direction,
    transport: input.transport ?? "http", uploaded_by: userId,
  }).select("id").single();
  if (insertError) return { ok: false as const, error: "manifest_not_recorded" };
  return { ok: true as const, id: row.id };
}

/** JWT identity is authenticated by the route on *every* request, not by a URL. */
export async function fileByteResponse(
  request: Request, sessionId: string, admin: SupabaseClient<Database>, userId: string,
) {
  const check = () => assertSessionAccess(admin, userId, sessionId);
  if (await check()) return bad(403, "forbidden");
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some(key => !["path", "fileId", "fileIds"].includes(key)))
    return bad(400, "invalid_query");

  if (request.method === "PUT") {
    const path = url.searchParams.get("path");
    if (!validFilePath(sessionId, path)) return bad(400, "invalid_path");
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES))
      return bad(413, "file_too_large");
    const chunks: BlobPart[] = [];
    let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_FILE_BYTES) {
            await reader.cancel();
            return bad(413, "file_too_large");
          }
          chunks.push(new Uint8Array(value).buffer);
        }
      } finally { reader.releaseLock(); }
    }
    if (length !== null && Number(length) !== size) return bad(400, "size_mismatch");
    if (await check()) return bad(403, "authorization_changed");
    if (await sessionBytesUsed(admin, sessionId) + size > MAX_SESSION_BYTES)
      return bad(413, "session_quota_exceeded");
    if (await check()) return bad(403, "authorization_changed");
    const { error } = await admin.storage.from(BUCKET).upload(path, new Blob(chunks), {
      contentType: "application/octet-stream", upsert: false,
    });
    if (error) return bad(409, "upload_failed");
    if (await check()) {
      await admin.storage.from(BUCKET).remove([path]);
      return bad(403, "authorization_changed");
    }
    return Response.json({ ok: true, path }, { headers: { "cache-control": "no-store" } });
  }

  if (request.method !== "GET") return bad(405, "method_not_allowed");
  if (url.searchParams.has("path")) return bad(400, "manifest_id_required");
  const id = url.searchParams.get("fileId");
  const ids = url.searchParams.get("fileIds")?.split(",");
  if (!!id === !!ids || (ids && (ids.length === 0 || ids.length > 200 || ids.some(v => !v))))
    return bad(400, "invalid_file_ids");
  const wanted = ids ?? [id!];
  const { data: rows, error: rowError } = await admin.from("session_files")
    .select("id, name, storage_path, size_bytes").eq("session_id", sessionId)
    .is("deleted_at", null).in("id", wanted);
  if (rowError || !rows || rows.length !== new Set(wanted).size) return bad(404, "not_found");
  if (rows.some(row => !validFilePath(sessionId, row.storage_path))) return bad(400, "invalid_path");
  const total = rows.reduce((n, row) => n + Number(row.size_bytes), 0);
  if (!Number.isFinite(total) || total < 0 || total > MAX_SESSION_BYTES ||
      rows.some(row => Number(row.size_bytes) < 0 || Number(row.size_bytes) > MAX_FILE_BYTES))
    return bad(413, "file_too_large");
  let secret: { wrapped_password: string; iv: string; expires_at: string } | null = null;
  if (ids) {
    const { data } = await admin.from("session_secrets").select("wrapped_password, iv, expires_at")
      .eq("session_id", sessionId).maybeSingle();
    if (!data || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now())
      return bad(409, "no_password");
    secret = data;
  }
  const entries: { name: string; data: Blob }[] = [];
  for (const row of rows) {
    if (await check()) return bad(403, "authorization_changed");
    const { data: blob, error } = await admin.storage.from(BUCKET).download(row.storage_path);
    if (error || !blob) return bad(500, "download_failed");
    if (blob.size !== Number(row.size_bytes) || blob.size > MAX_FILE_BYTES) return bad(409, "size_mismatch");
    entries.push({ name: safeName(row.name), data: blob });
  }
  if (await check()) return bad(403, "authorization_changed");
  if (!ids) return attachment(entries[0].data, entries[0].name);
  const password = await unwrapPassword(secret!.wrapped_password, secret!.iv);
  const zip = await buildEncryptedZip(entries, password);
  if (await check()) return bad(403, "authorization_changed");
  return attachment(zip, "connectlive-files.zip");
}
