import { createFileRoute } from "@tanstack/react-router";
import { adminClient } from "@/lib/server-supabase";
import {
  BUCKET,
  MAX_FILE_BYTES,
  MAX_SESSION_BYTES,
  buildEncryptedZip,
  safeName,
  sessionBytesUsed,
  signDownload,
  signUpload,
  storagePathFor,
  unwrapPassword,
  verifyAccountPassword,
  wrapPassword,
} from "@/lib/session-files.server";

/**
 * Authenticated native-admin routes for in-session file transfer.
 *
 * The web console uses createServerFn wrappers; the C# admin console can not
 * call those, so this route exposes the same operations as stable HTTP
 * endpoints secured with the technician's Supabase JWT.
 */

const EXPIRES_MINUTES = 5;

async function getUser(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return { admin, user: data.user };
}

async function assertAccess(
  admin: ReturnType<typeof adminClient>,
  userId: string,
  sessionId: string,
): Promise<"not_found" | "forbidden" | null> {
  const [{ data: session }, { data: isSuper }] = await Promise.all([
    admin.from("sessions").select("id, technician_id").eq("id", sessionId).maybeSingle(),
    admin.rpc("has_role", { _user_id: userId, _role: "super_admin" as never }),
  ]);
  if (!session) return "not_found";
  if (!isSuper && session.technician_id !== userId) return "forbidden";
  return null;
}

function bad(status: number, error: string) {
  return Response.json({ ok: false, error }, { status });
}

export const Route = createFileRoute("/api/public/admin/session/$sessionId/files")({
  server: {
    handlers: {
      // List manifest + password-cached flag + cumulative bytes.
      GET: async ({ request, params }) => {
        const ctx = await getUser(request);
        if (!ctx) return bad(401, "unauthorized");
        const denied = await assertAccess(ctx.admin, ctx.user.id, params.sessionId);
        if (denied) return denied === "forbidden" ? bad(403, denied) : bad(404, denied);

        const [{ data: files }, { data: secret }] = await Promise.all([
          ctx.admin
            .from("session_files")
            .select("id, name, size_bytes, mime, sha256, direction, transport, created_at")
            .eq("session_id", params.sessionId)
            .is("deleted_at", null)
            .order("created_at", { ascending: false }),
          ctx.admin
            .from("session_secrets")
            .select("expires_at")
            .eq("session_id", params.sessionId)
            .maybeSingle(),
        ]);
        const bytesUsed = (files ?? []).reduce((n, f) => n + Number(f.size_bytes ?? 0), 0);
        const hasPassword = !!secret && new Date(secret.expires_at).getTime() > Date.now();
        return Response.json({ ok: true, files: files ?? [], bytesUsed, hasPassword });
      },

      // Mint a one-shot signed upload URL for a file the admin is pushing.
      POST: async ({ request, params }) => {
        const ctx = await getUser(request);
        if (!ctx) return bad(401, "unauthorized");
        const denied = await assertAccess(ctx.admin, ctx.user.id, params.sessionId);
        if (denied) return denied === "forbidden" ? bad(403, denied) : bad(404, denied);

        const action = request.headers.get("x-action") ?? "prepare";

        if (action === "prepare") {
          let body: { name?: string; size?: number };
          try {
            body = (await request.json()) as { name?: string; size?: number };
          } catch {
            return bad(400, "invalid_json");
          }
          const name = safeName(body.name ?? "file");
          const size = Number(body.size ?? -1);
          if (!Number.isFinite(size) || size < 0) return bad(400, "invalid_size");
          if (size > MAX_FILE_BYTES) return bad(413, "file_too_large");
          const used = await sessionBytesUsed(ctx.admin, params.sessionId);
          if (used + size > MAX_SESSION_BYTES) return bad(413, "session_quota_exceeded");
          const path = storagePathFor(params.sessionId, name);
          const signed = await signUpload(ctx.admin, path);
          return Response.json({ ok: true, path: signed.path, token: signed.token, signedUrl: signed.signedUrl });
        }

        if (action === "register") {
          let body: {
            path?: string;
            name?: string;
            size?: number;
            mime?: string;
            sha256?: string;
            direction?: string;
            transport?: string;
          };
          try {
            body = (await request.json()) as any;
          } catch {
            return bad(400, "invalid_json");
          }
          const path = body.path ?? "";
          const name = safeName(body.name ?? "file");
          const size = Math.max(0, Math.round(Number(body.size ?? 0)));
          if (!path.startsWith(`${params.sessionId}/`)) return bad(400, "invalid_path");
          if (body.direction !== "from_agent" && body.direction !== "from_admin")
            return bad(400, "invalid_direction");
          const { data: row, error } = await ctx.admin
            .from("session_files")
            .insert({
              session_id: params.sessionId,
              direction: body.direction,
              name,
              size_bytes: size,
              mime: body.mime || "application/octet-stream",
              sha256: body.sha256 ?? null,
              storage_path: path,
              transport: body.transport ?? "http",
              uploaded_by: ctx.user.id,
            })
            .select("id")
            .single();
          if (error) return bad(500, "insert_failed");
          return Response.json({ ok: true, id: row.id });
        }

        if (action === "package") {
          let body: { fileIds?: string[] };
          try {
            body = (await request.json()) as { fileIds?: string[] };
          } catch {
            return bad(400, "invalid_json");
          }
          if (!Array.isArray(body.fileIds) || body.fileIds.length === 0) return bad(400, "no_files");
          if (body.fileIds.length > 200) return bad(400, "too_many_files");

          const { data: secret } = await ctx.admin
            .from("session_secrets")
            .select("wrapped_password, iv, expires_at")
            .eq("session_id", params.sessionId)
            .maybeSingle();
          if (!secret || new Date(secret.expires_at).getTime() < Date.now())
            return bad(409, "no_password");

          const { data: rows } = await ctx.admin
            .from("session_files")
            .select("id, name, storage_path, size_bytes")
            .eq("session_id", params.sessionId)
            .is("deleted_at", null)
            .in("id", body.fileIds);
          if (!rows || rows.length === 0) return bad(404, "not_found");

          const entries: { name: string; data: Blob }[] = [];
          for (const row of rows) {
            const { data: blob, error } = await ctx.admin.storage.from(BUCKET).download(row.storage_path);
            if (error || !blob) return bad(500, "download_failed");
            entries.push({ name: row.name, data: blob });
          }

          const password = await unwrapPassword(secret.wrapped_password, secret.iv);
          const zip = await buildEncryptedZip(entries, password);
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const zipPath = `${params.sessionId}/zips/connectlive-files-${stamp}.zip`;
          const { error: upErr } = await ctx.admin.storage
            .from(BUCKET)
            .upload(zipPath, zip, { contentType: "application/zip", upsert: true });
          if (upErr) return bad(500, "zip_upload_failed");

          return Response.json({
            ok: true,
            count: entries.length,
            url: await signDownload(ctx.admin, zipPath, EXPIRES_MINUTES * 60, `connectlive-files-${stamp}.zip`),
          });
        }

        if (action === "password") {
          let body: { email?: string; password?: string };
          try {
            body = (await request.json()) as { email?: string; password?: string };
          } catch {
            return bad(400, "invalid_json");
          }
          const email = (body.email ?? "").trim().toLowerCase();
          const password = body.password ?? "";
          if (!email.includes("@")) return bad(400, "invalid_email");
          if (password.length < 6) return bad(400, "invalid_password");
          const valid = await verifyAccountPassword(email, password);
          if (!valid) return bad(401, "bad_credentials");
          const { wrapped, iv } = await wrapPassword(password);
          await ctx.admin.from("session_secrets").upsert({
            session_id: params.sessionId,
            wrapped_password: wrapped,
            iv,
            created_by: ctx.user.id,
            expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          });
          return Response.json({ ok: true });
        }

        return bad(400, "unknown_action");
      },

      DELETE: async ({ request, params }) => {
        const ctx = await getUser(request);
        if (!ctx) return bad(401, "unauthorized");
        const denied = await assertAccess(ctx.admin, ctx.user.id, params.sessionId);
        if (denied) return denied === "forbidden" ? bad(403, denied) : bad(404, denied);

        let body: { fileId?: string };
        try {
          body = (await request.json()) as { fileId?: string };
        } catch {
          return bad(400, "invalid_json");
        }
        if (!body.fileId) return bad(400, "invalid_input");
        const { data: row } = await ctx.admin
          .from("session_files")
          .select("storage_path")
          .eq("id", body.fileId)
          .eq("session_id", params.sessionId)
          .maybeSingle();
        if (!row) return bad(404, "not_found");
        await ctx.admin.storage.from(BUCKET).remove([row.storage_path]);
        await ctx.admin
          .from("session_files")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", body.fileId)
          .eq("session_id", params.sessionId);
        return Response.json({ ok: true });
      },
    },
  },
});
