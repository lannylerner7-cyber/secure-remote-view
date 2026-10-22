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
  serviceClient,
  sessionBytesUsed,
  storagePathFor,
  verifyAccountPassword,
  wrapPassword,
  BUCKET,
} from "@/lib/session-files.server";
import { fileProxyUrl, registerUploadedFile, validFilePath } from "@/lib/session-file-proxy.server";

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

/** Prepare an identifier-only URL; every byte request still needs a fresh JWT. */
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
    return { ok: true as const, path, url: fileProxyUrl(data.sessionId, { path }) };
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
      if (typeof data.path !== "string" || !data.path.startsWith(`${data.sessionId}/`))
        throw new Error("invalid_path");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    const denied = await assertSessionAccess(context.supabase, context.userId, data.sessionId);
    if (denied) return { ok: false as const, error: denied };
    const admin = serviceClient();
    return registerUploadedFile(admin, context.userId, data);
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
    if (!validFilePath(data.sessionId, row.storage_path))
      return { ok: false as const, error: "invalid_path" as const };
    if (await assertSessionAccess(admin, context.userId, data.sessionId))
      return { ok: false as const, error: "authorization_changed" as const };
    await admin.storage.from(BUCKET).remove([row.storage_path]);
    await admin
      .from("session_files")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", data.fileId);
    return { ok: true as const };
  });

/** Identifier-only download URL, not a bearer capability. */
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
    return { ok: true as const, url: fileProxyUrl(data.sessionId, { fileId: data.fileId }) };
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
 * customer password. Return a JWT-required proxy URL; the proxy revalidates,
 * builds and returns the encrypted bytes on demand without a bearer token.
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

    return {
      ok: true as const,
      count: rows.length,
      url: fileProxyUrl(data.sessionId, { fileIds: data.fileIds.join(",") }),
    };
  });
