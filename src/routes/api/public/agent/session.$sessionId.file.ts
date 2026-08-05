import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";
import {
  BUCKET,
  MAX_FILE_BYTES,
  MAX_SESSION_BYTES,
  safeName,
  sessionBytesUsed,
} from "@/lib/session-files.server";

/**
 * Step 8 — HTTP chunk fallback for in-session file transfer.
 *
 * The primary path is the `files` WebRTC DataChannel. When ICE is down (or
 * demoted mid-transfer) the agent POSTs the same envelope here:
 *
 *   POST /api/public/agent/session/{id}/file?fileId=&seq=&eof=1
 *   headers: x-file-name, x-file-mime, x-file-sha256, x-file-size
 *   body:    raw chunk bytes (<= 8 MiB)
 *
 * Chunks land as discrete objects under `<session>/parts/<fileId>/<seq>` and
 * are concatenated into the final object on the `eof=1` request, at which
 * point the manifest row is written and the parts are pruned. Same private
 * bucket, same quotas as the datachannel path.
 */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

export const Route = createFileRoute("/api/public/agent/session/$sessionId/file")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const url = new URL(request.url);
        const fileId = (url.searchParams.get("fileId") ?? "").replace(/[^A-Za-z0-9-]/g, "");
        const seq = Number(url.searchParams.get("seq") ?? "0");
        const eof = url.searchParams.get("eof") === "1";
        if (!fileId || !Number.isFinite(seq) || seq < 0)
          return new Response(JSON.stringify({ error: "invalid_envelope" }), { status: 400 });

        const { data: session } = await ctx.admin
          .from("sessions")
          .select("id, device_id, state")
          .eq("id", params.sessionId)
          .maybeSingle();
        if (!session || session.device_id !== ctx.device.id)
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        if (session.state !== "active")
          return new Response(JSON.stringify({ error: "not_active", state: session.state }), {
            status: 409,
          });

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > MAX_CHUNK_BYTES)
          return new Response(JSON.stringify({ error: "chunk_too_large" }), { status: 413 });

        const partPath = `${session.id}/parts/${fileId}/${String(seq).padStart(6, "0")}`;
        if (bytes.byteLength > 0) {
          const { error } = await ctx.admin.storage
            .from(BUCKET)
            .upload(partPath, bytes, { contentType: "application/octet-stream", upsert: true });
          if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
        if (!eof) return new Response(JSON.stringify({ ok: true, seq }), { headers: { "content-type": "application/json" } });

        // Final chunk: stitch the parts, publish the object, write the row.
        const { data: parts } = await ctx.admin.storage
          .from(BUCKET)
          .list(`${session.id}/parts/${fileId}`, { limit: 10_000, sortBy: { column: "name", order: "asc" } });
        const blobs: Blob[] = [];
        for (const part of parts ?? []) {
          const { data: blob } = await ctx.admin.storage
            .from(BUCKET)
            .download(`${session.id}/parts/${fileId}/${part.name}`);
          if (blob) blobs.push(blob);
        }
        const merged = new Blob(blobs);
        if (merged.size > MAX_FILE_BYTES)
          return new Response(JSON.stringify({ error: "file_too_large" }), { status: 413 });

        const used = await sessionBytesUsed(ctx.admin as never, session.id);
        if (used + merged.size > MAX_SESSION_BYTES)
          return new Response(JSON.stringify({ error: "session_quota_exceeded" }), { status: 413 });

        const name = safeName(request.headers.get("x-file-name") ?? "file");
        const mime = request.headers.get("x-file-mime") ?? "application/octet-stream";
        const sha256 = request.headers.get("x-file-sha256");
        const finalPath = `${session.id}/${fileId}-${name}`;
        const { error: upErr } = await ctx.admin.storage
          .from(BUCKET)
          .upload(finalPath, merged, { contentType: mime, upsert: true });
        if (upErr) return new Response(JSON.stringify({ error: upErr.message }), { status: 500 });

        await ctx.admin.from("session_files").insert({
          session_id: session.id,
          direction: "from_agent",
          name,
          size_bytes: merged.size,
          mime,
          sha256,
          storage_path: finalPath,
          transport: "http",
        });

        const stale = (parts ?? []).map((p) => `${session.id}/parts/${fileId}/${p.name}`);
        if (stale.length) await ctx.admin.storage.from(BUCKET).remove(stale);

        return new Response(JSON.stringify({ ok: true, path: finalPath, size: merged.size }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
