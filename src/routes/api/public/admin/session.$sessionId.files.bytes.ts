import { createFileRoute } from "@tanstack/react-router";
import { adminClient } from "@/lib/server-supabase";
import { fileByteResponse } from "@/lib/session-file-proxy.server";

async function bytes({ request, params }: { request: Request; params: { sessionId: string } }) {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return new Response("unauthorized", { status: 401 });
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return new Response("unauthorized", { status: 401 });
  return fileByteResponse(request, params.sessionId, admin, data.user.id);
}

export const Route = createFileRoute("/api/public/admin/session/$sessionId/files/bytes")({
  server: { handlers: { GET: bytes, PUT: bytes } },
});
