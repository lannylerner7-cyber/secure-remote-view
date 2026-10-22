import { createFileRoute } from "@tanstack/react-router";
import { sessionAuthorized } from "@/lib/authorization.server";
import { adminClient } from "@/lib/server-supabase";
import {
  BUCKET,
  MAX_FILE_BYTES,
  MAX_SESSION_BYTES,
  safeName,
  sessionBytesUsed,
  storagePathFor,
  verifyAccountPassword,
  wrapPassword,
} from "@/lib/session-files.server";
import { fileProxyUrl, registerUploadedFile, validFilePath } from "@/lib/session-file-proxy.server";

/**
 * Authenticated native-admin routes for in-session file transfer.
 *
 * The web console uses createServerFn wrappers; the C# admin console can not
 * call those, so this route exposes the same operations as stable HTTP
 * endpoints secured with the technician's Supabase JWT.
 */

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
  const [{ data: session }, { data: isSuper, error: roleError }] = await Promise.all([
    admin.from("sessions").select("id, technician_id").eq("id", sessionId).maybeSingle(),
    admin.rpc("has_role", { _user_id: userId, _role: "super_admin" as never }),
  ]);
  if (!session) return "not_found";
  if (session.technician_id !== userId && (roleError || isSuper !== true)) return "forbidden";
  if (!(await sessionAuthorized(admin, sessionId, "files"))) return "forbidden";
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

      // Prepare an identifier-only proxy URL; it confers no access by itself.
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
          const url = fileProxyUrl(params.sessionId, { path });
          // signedUrl is a compatibility DTO field for native Admin, not a signed URL.
          return Response.json({ ok: true, path, url, signedUrl: url });
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
          const result = await registerUploadedFile(ctx.admin, ctx.user.id, {
            sessionId: params.sessionId, path: body.path ?? "", name: body.name ?? "file",
            size: body.size ?? -1, direction: body.direction ?? "",
            mime: body.mime, sha256: body.sha256, transport: body.transport,
          });
          return Response.json(result, { status: result.ok ? 200 : 400 });
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

          return Response.json({
            ok: true,
            count: rows.length,
            url: fileProxyUrl(params.sessionId, { fileIds: body.fileIds.join(",") }),
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
        if (!validFilePath(params.sessionId, row.storage_path)) return bad(400, "invalid_path");
        if (await assertAccess(ctx.admin, ctx.user.id, params.sessionId)) return bad(403, "authorization_changed");
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
