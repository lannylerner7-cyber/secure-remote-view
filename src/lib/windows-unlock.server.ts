import { createHash, createPublicKey } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { adminClient } from "./server-supabase";
import { verifyDevice, deviceAuthFailure } from "./agent-auth.server";
import type { Database, Json } from "@/integrations/supabase/types";

type Receipt = { device_identity: string; token_hash: string; key_id: string; revoked_at: string; cleared_at: string | null };
type UnlockDatabase = { public: Omit<Database["public"], "Tables" | "Functions"> & {
  Tables: Database["public"]["Tables"] & {
    device_unlock_revocations: { Row: Receipt; Insert: Receipt; Update: Partial<Receipt>; Relationships: [] };
  };
  Functions: Database["public"]["Functions"] & {
    unlock_admin: { Args: { _actor: string; _device: string; _action: string; _body: Json }; Returns: Json };
    unlock_agent: { Args: { _device: string; _action: string; _body: Json }; Returns: Json };
  };
} };
const database = (client = adminClient()) => client as unknown as SupabaseClient<UnlockDatabase>;
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});
const uuid = z.string().uuid();
const peer = z.string().regex(/^(?:[A-Za-z0-9_-]{16,64}|[0-9a-fA-F-]{36})$/);
const sealedPin = z.object({
  version: z.literal(1), algorithm: z.literal("RSA-OAEP-256+A256GCM"), keyId: uuid,
  wrappedKey: z.string().regex(/^[A-Za-z0-9+/]{512}$/),
  iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9+/]{26,192}={0,2}$/),
}).strict();
const adminBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), authorizationId: uuid, sealedPin }).strict(),
  z.object({ action: z.literal("begin"), sessionId: uuid, peerId: peer }).strict(),
  z.object({ action: z.literal("forget") }).strict(),
  z.object({ action: z.literal("revoke") }).strict(),
]);
const binding = { keyId: uuid, requestId: uuid, sessionId: uuid, peerId: peer };
const agentBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable"), version: z.literal(1), authorizationId: uuid,
    keyId: uuid, publicKey: z.string().regex(/^[A-Za-z0-9+/]{500,1200}={0,2}$/),
    windowsAccount: z.string().min(1).max(200), consentAccepted: z.literal(true) }).strict(),
  z.object({ action: z.literal("status"), keyId: uuid }).strict(),
  z.object({ action: z.literal("cleared"), keyId: uuid }).strict(),
  z.object({ action: z.literal("revoke"), keyId: uuid }).strict(),
  z.object({ action: z.literal("report"), keyId: uuid,
    locked: z.boolean().nullable(), helperReady: z.boolean() }).strict(),
  z.object({ action: z.literal("acquire"), ...binding }).strict(),
  z.object({ action: z.literal("permit"), ...binding }).strict(),
  z.object({ action: z.literal("pin"), ...binding }).strict(),
  z.object({ action: z.literal("end"), ...binding, osUnlocked: z.boolean() }).strict(),
]);
const knownErrors = new Set([
  "unlock_forbidden", "unlock_setup_required", "unlock_key_changed", "invalid_unlock_request",
  "unlock_session_unavailable", "unlock_rate_limited",
]);
function failure(message?: string) {
  const code = message && knownErrors.has(message) ? message : "unlock_unavailable";
  return json({ error: code }, code === "unlock_unavailable" ? 503 :
    code === "unlock_rate_limited" ? 429 : code === "unlock_forbidden" ? 403 : 409);
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  if (Number(request.headers.get("content-length")) > 8192) return null;
  // Bounded streamed body: do not allocate an arbitrary authenticated request.
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { return null; }
  finally { reader.releaseLock(); }
}
export async function handleAdminUnlock(request: Request, deviceId: string): Promise<Response> {
  if (!uuid.safeParse(deviceId).success) return json({ error: "invalid_unlock_request" }, 400);
  const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer) return json({ error: "unlock_forbidden" }, 401);
  try {
    const admin = adminClient();
    const { data: identity, error: authError } = await admin.auth.getUser(bearer);
    if (authError || !identity.user) return json({ error: "unlock_forbidden" }, 401);
    let action = "status", body: Json = {};
    if (request.method !== "GET") {
      const parsed = adminBody.safeParse(await readBody(request));
      if (!parsed.success) return json({ error: "invalid_unlock_request" }, 400);
      action = parsed.data.action;
      const methods: Record<string, string> = { save: "PUT", begin: "POST", forget: "DELETE", revoke: "DELETE" };
      if (methods[action] !== request.method) return json({ error: "invalid_unlock_request" }, 405);
      body = parsed.data;
    }
    const { data, error } = await database(admin).rpc("unlock_admin", {
      _actor: identity.user.id, _device: deviceId, _action: action, _body: body,
    });
    return error ? failure(error.message) : json(data);
  } catch { return failure(); }
}
export async function handleAgentUnlock(request: Request): Promise<Response> {
  try {
    const parsed = agentBody.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid_unlock_request" }, 400);
    const body = parsed.data;
    const ctx = await verifyDevice(request);
    if (ctx.kind === "unavailable") return deviceAuthFailure(ctx, "json");
    // Only an explicit matching tombstone authorizes deleting local key material.
    // An HTTP 401, proxy error, or unavailable lookup never does.
    if (body.action === "status" || body.action === "cleared") {
      const identity = request.headers.get("x-device-id");
      const token = request.headers.get("x-device-token");
      if (identity && identity.length <= 200 && token && token.length <= 512) {
        const client = database();
        const hash = createHash("sha256").update(token).digest("hex");
        const { data: receipt, error } = await client.from("device_unlock_revocations")
          .select("key_id").eq("device_identity", identity).eq("token_hash", hash).eq("key_id", body.keyId).maybeSingle();
        if (error) return failure();
        if (receipt) {
          if (body.action === "cleared") {
            const { error: updateError } = await client.from("device_unlock_revocations")
              .update({ cleared_at: new Date().toISOString() })
              .eq("device_identity", identity).eq("token_hash", hash).eq("key_id", body.keyId);
            if (updateError) return failure();
          }
          return json({ revoked: true, keyId: body.keyId });
        }
      }
    }
    if (ctx.kind !== "verified") return deviceAuthFailure(ctx, "json");
    if (body.action === "cleared") return json({ error: "unlock_forbidden" }, 403);
    if (body.action === "enable") {
      // DER SPKI only. Reject private keys, other algorithms and weak RSA keys.
      let key;
      try { key = createPublicKey({ key: Buffer.from(body.publicKey, "base64"), format: "der", type: "spki" }); }
      catch { return json({ error: "invalid_unlock_request" }, 400); }
      if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072)
        return json({ error: "invalid_unlock_request" }, 400);
    }
    const { data, error } = await database(ctx.admin).rpc("unlock_agent", {
      _device: ctx.device.id, _action: body.action, _body: body,
    });
    return error ? failure(error.message) : json(data);
  } catch { return failure(); }
}
