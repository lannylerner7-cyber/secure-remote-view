/**
 * Step 8 — authenticated server functions behind the console "Files" panel.
 * Thin wrappers only: every helper lives in session-files.server.ts.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  MAX_FILE_BYTES,
  MAX_SESSION_BYTES,
  assertSessionAccess,
  buildEncryptedZip,
  safeName,
  serviceClient,
  sessionBytesUsed,
  signDownload,
  signUpload,
  storagePathFor,
  unwrapPassword,
  verifyAccountPassword,
  wrapPassword,
  BUCKET,
} from "@/lib/session-files.server";

export const listSessionFiles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string }) => {
    if (!data?.sessionId || typeof data.sessionId !== "string") throw new Error("invalid_session_id");
    return data;
  })
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied, files: [], bytesUsed: 0, hasPassword: false };
    const admin = serviceClient();
    const [{ data: files }, { data: secret }] = await Promise.all([
      admin
        .from("session_files")
        .select("id, name, size_bytes, mime, sha256, direction, transport, created_at")
        .eq("session_id", data.sessionId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      admin
        .from("session_secrets")
        .select("expires_at")
        .eq("session_id", data.sessionId)
        .maybeSingle(),
    ]);
    const hasPassword = !!secret && new Date(secret.expires_at).getTime() > Date.now();
    const bytesUsed = (files ?? []).reduce((n, f) => n + Number(f.size_bytes ?? 0), 0);
    return { ok: true as const, files: files ?? [], bytesUsed, hasPassword };
  });

/** Mint a one-shot signed upload URL for a file about to be pushed. */
export const prepareSessionUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; name: string; size: number }) => {
    if (!data?.sessionId) throw new Error("invalid_session_id");
    if (!data?.name) throw new Error("invalid_name");
    if (!Number.isFinite(data.size) || data.size < 0) throw new Error("invalid_size");
    return data;
  })
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    if (data.size > MAX_FILE_BYTES) return { ok: false as const, error: "file_too_large" as const };
    const admin = serviceClient();
    const used = await sessionBytesUsed(admin, data.sessionId);
    if (used + data.size > MAX_SESSION_BYTES)
      return { ok: false as const, error: "session_quota_exceeded" as const };
    const path = storagePathFor(data.sessionId, data.name);
    const signed = await signUpload(admin, path);
    return { ok: true as const, path: signed.path, token: signed.token };
  });

/** Record the manifest row once the bytes are in the bucket. */
export const registerSessionFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      sessionId: string;
      path: string;
      name: string;
      size: number;
      mime?: string;
      sha256?: string;
      direction: "from_agent" | "from_admin";
      transport?: "datachannel" | "http";
    }) => {
      if (!data?.sessionId || !data?.path || !data?.name) throw new Error("invalid_input");
      if (data.direction !== "from_agent" && data.direction !== "from_admin")
        throw new Error("invalid_direction");
      if (!data.path.startsWith(`${data.sessionId}/`)) throw new Error("invalid_path");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    const admin = serviceClient();
    const { data: row, error } = await admin
      .from("session_files")
      .insert({
        session_id: data.sessionId,
        direction: data.direction,
        name: safeName(data.name),
        size_bytes: Math.max(0, Math.round(data.size)),
        mime: data.mime || "application/octet-stream",
        sha256: data.sha256 ?? null,
        storage_path: data.path,
        transport: data.transport ?? "datachannel",
        uploaded_by: context.userId,
      })
      .select("id")
      .single();
    if (error) return { ok: false as const, error: "insert_failed" as const };
    return { ok: true as const, id: row.id };
  });

export const deleteSessionFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; fileId: string }) => {
    if (!data?.sessionId || !data?.fileId) throw new Error("invalid_input");
    return data;
  })
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    const admin = serviceClient();
    const { data: row } = await admin
      .from("session_files")
      .select("storage_path")
      .eq("id", data.fileId)
      .eq("session_id", data.sessionId)
      .maybeSingle();
    if (!row) return { ok: false as const, error: "not_found" as const };
    await admin.storage.from(BUCKET).remove([row.storage_path]);
    await admin
      .from("session_files")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", data.fileId);
    return { ok: true as const };
  });

/** Single-file download link (plain, unencrypted) — 5 minute signed URL. */
export const getSessionFileUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; fileId: string }) => {
    if (!data?.sessionId || !data?.fileId) throw new Error("invalid_input");
    return data;
  })
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    const admin = serviceClient();
    const { data: row } = await admin
      .from("session_files")
      .select("storage_path, name")
      .eq("id", data.fileId)
      .eq("session_id", data.sessionId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!row) return { ok: false as const, error: "not_found" as const };
    return { ok: true as const, url: await signDownload(admin, row.storage_path, 300, row.name) };
  });

/**
 * Verify-and-cache flow: the customer's own account password is checked
 * against auth, then wrapped with AES-GCM and parked for the session. The
 * plaintext is never stored, logged, or returned.
 */
export const cacheSessionPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; email: string; password: string }) => {
    if (!data?.sessionId) throw new Error("invalid_session_id");
    if (!data?.email || !data.email.includes("@")) throw new Error("invalid_email");
    if (!data?.password || data.password.length < 6) throw new Error("invalid_password");
    return data;
  })
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    const valid = await verifyAccountPassword(data.email.trim().toLowerCase(), data.password);
    if (!valid) return { ok: false as const, error: "bad_credentials" as const };
    const { wrapped, iv } = await wrapPassword(data.password);
    const admin = serviceClient();
    await admin.from("session_secrets").upsert({
      session_id: data.sessionId,
      wrapped_password: wrapped,
      iv,
      created_by: context.userId,
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });
    return { ok: true as const };
  });

export const clearSessionPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string }) => {
    if (!data?.sessionId) throw new Error("invalid_session_id");
    return data;
  })
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    await serviceClient().from("session_secrets").delete().eq("session_id", data.sessionId);
    return { ok: true as const };
  });

/**
 * Package the selected files into one AES-256 zip locked with the cached
 * customer password, park it in the bucket and hand back a 5-minute link.
 */
export const packageSessionFiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; fileIds: string[] }) => {
    if (!data?.sessionId) throw new Error("invalid_session_id");
    if (!Array.isArray(data.fileIds) || data.fileIds.length === 0) throw new Error("no_files");
    if (data.fileIds.length > 200) throw new Error("too_many_files");
    return data;
  })
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    const admin = serviceClient();

    const { data: secret } = await admin
      .from("session_secrets")
      .select("wrapped_password, iv, expires_at")
      .eq("session_id", data.sessionId)
      .maybeSingle();
    if (!secret || new Date(secret.expires_at).getTime() < Date.now())
      return { ok: false as const, error: "no_password" as const };

    const { data: rows } = await admin
      .from("session_files")
      .select("id, name, storage_path, size_bytes")
      .eq("session_id", data.sessionId)
      .is("deleted_at", null)
      .in("id", data.fileIds);
    if (!rows || rows.length === 0) return { ok: false as const, error: "not_found" as const };

    const entries: { name: string; data: Blob }[] = [];
    for (const row of rows) {
      const { data: blob, error } = await admin.storage.from(BUCKET).download(row.storage_path);
      if (error || !blob) return { ok: false as const, error: "download_failed" as const };
      entries.push({ name: row.name, data: blob });
    }

    const password = await unwrapPassword(secret.wrapped_password, secret.iv);
    const zip = await buildEncryptedZip(entries, password);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipPath = `${data.sessionId}/zips/connectlive-files-${stamp}.zip`;
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(zipPath, zip, { contentType: "application/zip", upsert: true });
    if (upErr) return { ok: false as const, error: "zip_upload_failed" as const };

    return {
      ok: true as const,
      count: entries.length,
      url: await signDownload(admin, zipPath, 300, `connectlive-files-${stamp}.zip`),
    };
  });
