import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sessionAuthorized } from "./authorization.server";
import { BUCKET, MAX_FILE_BYTES, safeName } from "./session-files.server";
import { fileSpool, storedChecksum } from "./file-spool.server";

type FileReceipt = { id:string; session_id:string; authorization_id:string; controller_id:string; peer_id:string; agent_instance:string|null;
  size_bytes:number; sha256:string|null; name:string; direction:string|null; storage_path:string; state:string; created_at:string };
type FileDatabase = { public: Omit<Database["public"], "Functions" | "Tables"> & {
  Tables: Database["public"]["Tables"] & {
    session_file_receipts: { Row: FileReceipt; Insert: FileReceipt; Update: Partial<FileReceipt>; Relationships: [] };
  }; Functions: Database["public"]["Functions"] & {
  reserve_session_file: { Args: { _session: string; _id: string; _size: number; _sha: string; _name: string;
    _direction: string; _controller: string; _peer: string; _instance?:string }; Returns: { state: string; path: string; id: string } };
  complete_session_file: { Args: { _session: string; _id: string; _controller: string; _peer: string;
    _mime: string; _transport: string; _actor?: string }; Returns: { ok: boolean; state: string; path: string; id: string } };
  confirm_direct_session_file: { Args: { _session:string; _id:string; _size:number; _sha:string; _controller:string; _peer:string };
    Returns:{state:string;id:string;size:number;sha256:string} };
} } };
export const fileDatabase = (db: SupabaseClient<Database>) => db as unknown as SupabaseClient<FileDatabase>;
const fail = (error: string, status = 409) => Response.json({ ok: false, error },
  { status, headers: { "cache-control": "no-store" } });
const success = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });
const CHUNK = 4 * 1024 * 1024;
const assembling = new Set<string>();

/** No incomplete manifest, overwrite, or automatic cleanup of recoverable parts. */
export async function receiveAgentFile(request: Request, sessionId: string,
  db: SupabaseClient<Database>, deviceId: string): Promise<Response> {
  const url = new URL(request.url), rawId = url.searchParams.get("fileId") ?? "";
  const seqText = url.searchParams.get("seq") ?? "", seq = Number(seqText);
  const eof = url.searchParams.get("eof") === "1";
  const action = request.headers.get("x-file-action") ?? "upload";
  const instance = request.headers.get("x-file-instance");
  const sizeText = request.headers.get("x-file-size") ?? "", size = Number(sizeText);
  const sha = request.headers.get("x-file-sha256") ?? "";
  let rawName = request.headers.get("x-file-name") ?? "file";
  if (request.headers.get("x-file-name-encoding") === "uri") {
    try { rawName = decodeURIComponent(rawName); } catch { return fail("invalid_file_name",400); }
  }
  const name = safeName(rawName);
  const mime = (request.headers.get("x-file-mime") ?? "application/octet-stream").slice(0, 128);
  if (!/^[a-f0-9]{32}$|^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(rawId) ||
      (action === "upload" && (!/^\d{1,3}$/.test(seqText) || seq > Math.floor(MAX_FILE_BYTES / CHUNK))) ||
      !["upload","reserve","receipt"].includes(action) ||
      (instance !== null && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(instance)) ||
      (action !== "upload" && instance === null) ||
      !/^\d{1,10}$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(sha)) return fail("invalid_file_metadata", 400);
  const compact = rawId.replaceAll("-", "").toLowerCase();
  const id = `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`;
  const total = Math.max(1, Math.ceil(size / CHUNK));
  if (action === "upload" && (seq >= total || eof !== (seq === total - 1))) return fail("invalid_sequence", 400);
  const { data: session, error } = await db.from("sessions").select("id,device_id,admin_client_id")
    .eq("id", sessionId).maybeSingle();
  if (error) return fail("authority_unavailable", 503);
  if (!session || session.device_id !== deviceId) return fail("not_found", 404);
  const controller = String(session.admin_client_id ?? "");
  const peer = request.headers.get("x-file-peer") ?? "";
  if ((request.headers.has("x-file-controller") && request.headers.get("x-file-controller") !== controller) ||
      !/^[A-Za-z0-9_-]{0,64}$/.test(peer)) return fail("file_peer_changed");
  const current = async () => !request.signal.aborted && await sessionAuthorized(db, sessionId, "files");
  if (!await current()) return fail("authorization_changed");
  const direction = action === "upload" ? "from_agent" : request.headers.get("x-file-direction");
  if (direction !== "from_admin" && direction !== "from_agent") return fail("invalid_direction",400);
  const { data: reserved, error: reserveError } = await fileDatabase(db).rpc("reserve_session_file", {
    _session: sessionId, _id: id, _size: size, _sha: sha, _name: name,
    _direction: direction, _controller: controller, _peer: peer, ...(instance ? {_instance:instance} : {}),
  });
  if (reserveError || !reserved) return fail(reserveError?.code === "PGRST202"
    ? "transfer_schema_required" : "transfer_not_authorized");
  if (action === "reserve") return success({ok:true,id,state:reserved.state,size,sha256:sha});
  if (action === "receipt") {
    if (!await current()) return fail("authorization_changed");
    const receipt = await fileDatabase(db).rpc("confirm_direct_session_file", {
      _session:sessionId,_id:id,_size:size,_sha:sha,_controller:controller,_peer:peer,
    });
    return receipt.error || !receipt.data ? fail("direct_receipt_unconfirmed") : success({ok:true,...receipt.data});
  }
  if (reserved.state === "complete") return success({ ok: true, state: "complete", id, path: reserved.path, size, sha256: sha });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > CHUNK) { await reader.cancel(); return fail("chunk_too_large", 413); }
      chunks.push(part.value);
    }
  } catch { return fail("chunk_read_failed"); }
  finally { reader?.releaseLock(); }
  if (length !== Math.min(CHUNK, size - seq * CHUNK)) return fail("chunk_length_mismatch");
  const bytes = new Blob(chunks as BlobPart[]);
  const bucket = db.storage.from(BUCKET), prefix = `${sessionId}/parts/${id}`;
  const partPath = `${prefix}/${String(seq).padStart(6, "0")}`;
  if (!await current()) return fail("authorization_changed");
  const uploaded = await bucket.upload(partPath, bytes, { contentType: "application/octet-stream", upsert: false });
  if (uploaded.error) {
    // An uncertain write may be acknowledged only after comparing its exact bytes.
    const existing = await bucket.download(partPath);
    if (existing.error || !existing.data || existing.data.size !== length ||
        !Buffer.from(await existing.data.arrayBuffer()).equals(Buffer.from(await bytes.arrayBuffer())))
      return fail("chunk_write_unconfirmed");
  }
  if (!eof) return success({ ok: true, state: "part", id, seq });
  const { data: parts, error: listError } = await bucket.list(prefix, {
    limit: 128, sortBy: { column: "name", order: "asc" },
  });
  if (listError || !parts) return fail("part_listing_failed");
  if (parts.length !== total || parts.some((p, i) => p.name !== String(i).padStart(6, "0")))
    return fail("missing_or_unexpected_parts");
  if (assembling.has(id) || assembling.size >= 2) return fail("file_assembly_busy");
  assembling.add(id);
  const spool = await fileSpool().catch(error => { assembling.delete(id); throw error; });
  try {
    let received = 0;
    for (let i = 0; i < parts.length; i++) {
      if (!await current()) return fail("authorization_changed");
      const read = await bucket.download(`${prefix}/${parts[i]!.name}`);
      if (read.error || !read.data) return fail("part_unavailable");
      if (read.data.size !== Math.min(CHUNK, size - received)) return fail("part_length_mismatch");
      await spool.append(new Uint8Array(await read.data.arrayBuffer()));
      received += read.data.size;
    }
    const assembled = await spool.finish();
    if (received !== size || assembled.size !== size || assembled.sha256 !== sha) return fail("file_integrity_failed");
    if (!await current()) return fail("authorization_changed");
    const final = await bucket.upload(reserved.path, assembled.blob, { contentType: mime, upsert: false });
    if (final.error) {
      const old = await bucket.download(reserved.path);
      if (old.error || !old.data || old.data.size !== size || await storedChecksum(old.data) !== sha)
        return fail("file_write_unconfirmed");
    }
    // This transaction rechecks grant, process, controller, peer and duplicates.
    if (!await current()) return fail("authorization_changed");
    const completed = await fileDatabase(db).rpc("complete_session_file", {
      _session: sessionId, _id: id, _controller: controller, _peer: peer, _mime: mime, _transport: "http",
    });
    if (completed.error || completed.data?.state !== "complete") return fail("manifest_not_confirmed");
    // Cleanup is optional after durable completion. An uncertain cleanup cannot
    // convert a confirmed receipt to a retryable filesystem write.
    await bucket.remove(parts.map(p => `${prefix}/${p.name}`)).catch(()=>{});
    return success({ ok: true, state: "complete", id, path: reserved.path, size, sha256: sha });
  } finally { assembling.delete(id); await spool.dispose(); }
}
