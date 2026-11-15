import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { fileSpool, storedChecksum as checksum } from "./file-spool.server";
import { fileDatabase } from "./agent-file-upload.server";
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
    id?: string; controllerId?: string; peerId?: string;
  },
) {
  const check = () => assertSessionAccess(admin, userId, input.sessionId);
  if (await check()) return { ok: false as const, error: "forbidden" };
  if (!validFilePath(input.sessionId, input.path)) return { ok: false as const, error: "invalid_path" };
  if (typeof input.name !== "string" || !input.name ||
      (input.mime !== undefined && (typeof input.mime !== "string" || input.mime.length > 256)) ||
      typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))
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
  if (await checksum(blob) !== input.sha256) return { ok: false as const, error: "checksum_mismatch" };
  if (await check()) return { ok: false as const, error: "authorization_changed" };
  const intent = await fileDatabase(admin).from("session_file_receipts").select("*").eq("session_id",input.sessionId)
    .eq("storage_path",input.path).maybeSingle();
  if (intent.error || !intent.data) return { ok:false as const,error:"file_reservation_required" };
  const id = input.id ?? intent.data.id, controller = input.controllerId ?? intent.data.controller_id,
    peer = input.peerId ?? intent.data.peer_id;
  const reservation = await fileDatabase(admin).rpc("reserve_session_file", {
    _session:input.sessionId, _id:id, _size:input.size, _sha:input.sha256, _name:safeName(input.name),
    _direction:input.direction, _controller:controller, _peer:peer,
  });
  if (reservation.error || reservation.data?.path !== input.path) return { ok:false as const,error:"file_binding_changed" };
  const result = await fileDatabase(admin).rpc("complete_session_file", {
    _session:input.sessionId, _id:id, _controller:controller, _peer:peer,
    _mime:input.mime || "application/octet-stream", _transport:input.transport ?? "http", _actor:userId,
  });
  if (result.error || result.data?.state !== "complete") return { ok:false as const,error:"manifest_not_confirmed" };
  return { ok: true as const, id: result.data.id };
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
    const intent = await fileDatabase(admin).from("session_file_receipts").select("*")
      .eq("session_id",sessionId).eq("storage_path",path).maybeSingle();
    if (intent.error || !intent.data) return bad(409,"file_reservation_required");
    const expectedSize = request.headers.has("x-file-size") ? Number(request.headers.get("x-file-size")) : Number(intent.data.size_bytes);
    const expectedSha = request.headers.get("x-file-sha256") ?? intent.data.sha256 ?? "";
    const controller = request.headers.get("x-file-controller") ?? intent.data.controller_id,
      peer = request.headers.get("x-file-peer") ?? intent.data.peer_id;
    const direction = request.headers.get("x-file-direction") ?? intent.data.direction ?? "";
    const leaf = path.slice(sessionId.length + 1), id = leaf.slice(0,36), name = leaf.slice(37);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_FILE_BYTES ||
        (expectedSha !== "" && !/^[a-f0-9]{64}$/.test(expectedSha)) || !["","from_admin","from_agent"].includes(direction))
      return bad(400,"expected_integrity_required");
    const reservation = await fileDatabase(admin).rpc("reserve_session_file", {
      _session:sessionId,_id:id,_size:expectedSize,_sha:expectedSha,_name:name,
      _direction:direction,_controller:controller,_peer:peer,
    });
    if (reservation.error || reservation.data?.path !== path) return bad(409,"file_binding_changed");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES))
      return bad(413, "file_too_large");
    const spool = await fileSpool();
    let size = 0;
    try {
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
          if (request.signal.aborted) return bad(409,"upload_cancelled");
          await spool.append(value);
        }
      } finally { reader.releaseLock(); }
    }
    if (length !== null && Number(length) !== size) return bad(400, "size_mismatch");
    if (await check()) return bad(403, "authorization_changed");
    const assembled = await spool.finish();
    const content = assembled.blob, actualSha = assembled.sha256;
    if (size !== expectedSize || (expectedSha !== "" && actualSha !== expectedSha)) return bad(409,"file_integrity_failed");
    if (await check()) return bad(403, "authorization_changed");
    const { error } = await admin.storage.from(BUCKET).upload(path, content, {
      contentType: "application/octet-stream", upsert: false,
    });
    if (error) {
      const previous = await admin.storage.from(BUCKET).download(path);
      if (previous.error || !previous.data || previous.data.size !== size || await checksum(previous.data) !== actualSha)
        return bad(409, "upload_unconfirmed");
    }
    if (await check()) {
      return bad(403, "authorization_changed");
    }
    return Response.json({ ok: true, path }, { headers: { "cache-control": "no-store" } });
    } finally { await spool.dispose(); }
  }

  if (request.method !== "GET") return bad(405, "method_not_allowed");
  if (url.searchParams.has("path")) return bad(400, "manifest_id_required");
  const id = url.searchParams.get("fileId");
  const ids = url.searchParams.get("fileIds")?.split(",");
  if (!!id === !!ids || (ids && (ids.length === 0 || ids.length > 200 || ids.some(v => !v))))
    return bad(400, "invalid_file_ids");
  const wanted = ids ?? [id!];
  const { data: rows, error: rowError } = await admin.from("session_files")
    .select("id, name, storage_path, size_bytes, sha256").eq("session_id", sessionId)
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
    if (row.sha256 && await checksum(blob) !== row.sha256) return bad(409,"checksum_mismatch");
    entries.push({ name: safeName(row.name), data: blob });
  }
  if (await check()) return bad(403, "authorization_changed");
  if (!ids) return attachment(entries[0].data, entries[0].name);
  const password = await unwrapPassword(secret!.wrapped_password, secret!.iv);
  const zip = await buildEncryptedZip(entries, password);
  if (await check()) return bad(403, "authorization_changed");
  return attachment(zip, "connectlive-files.zip");
}
