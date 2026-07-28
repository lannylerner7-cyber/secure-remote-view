/**
 * Authenticated server function used by the web admin console to write
 * WebRTC signals. Sitting on the server side lets us:
 *   - Enforce that the caller owns the session (technician_id = auth.uid()
 *     OR super_admin) BEFORE the insert instead of relying only on RLS.
 *   - Re-check the admin_client_id binding server-side under a fresh row
 *     lock so two admin tabs opening the same session can never both stamp
 *     signals with mismatched client ids.
 *   - Stamp attempt_id for idempotency (the ux_session_signals_attempt
 *     unique index turns retries into no-ops without breaking ordering).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const KINDS = new Set(["offer", "ice", "bye"]);
const MAX_PAYLOAD_BYTES = 32_000;

export const postAdminSignal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      sessionId: string;
      clientId: string;
      kind: "offer" | "ice" | "bye";
      payload: unknown;
      attemptId: string;
    }) => {
      if (!input || typeof input !== "object") throw new Error("invalid_input");
      if (typeof input.sessionId !== "string" || input.sessionId.length < 10)
        throw new Error("invalid_session_id");
      if (typeof input.clientId !== "string" || !CLIENT_ID_RE.test(input.clientId))
        throw new Error("invalid_client_id");
      if (!KINDS.has(input.kind)) throw new Error("invalid_kind");
      if (typeof input.attemptId !== "string" || input.attemptId.length < 4 || input.attemptId.length > 80)
        throw new Error("invalid_attempt_id");
      const size = JSON.stringify(input.payload ?? null).length;
      if (size > MAX_PAYLOAD_BYTES) throw new Error("payload_too_large");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Verify ownership: technician_id matches or the caller is super_admin.
    const [{ data: session, error: sErr }, { data: isSuper }] = await Promise.all([
      supabase
        .from("sessions")
        .select("id, technician_id, state, admin_client_id")
        .eq("id", data.sessionId)
        .maybeSingle(),
      supabase.rpc("has_role", { _user_id: userId, _role: "super_admin" as never }),
    ]);
    if (sErr || !session) return { ok: false as const, error: "not_found" as const };
    if (!isSuper && session.technician_id !== userId)
      return { ok: false as const, error: "forbidden" as const };
    if (!["invited", "consented", "active", "paused"].includes(session.state))
      return { ok: false as const, error: "not_active" as const };
    if (session.admin_client_id && session.admin_client_id !== data.clientId)
      return { ok: false as const, error: "superseded" as const };

    const { error: insErr } = await supabase.from("session_signals").insert({
      session_id: data.sessionId,
      from_side: "admin",
      kind: data.kind,
      payload: data.payload as never,
      admin_client_id: data.clientId,
      attempt_id: data.attemptId,
    } as never);
    if (insErr) {
      // Unique-violation on (session_id, attempt_id) means we already stored
      // this exact signal — treat as success so client retries are idempotent.
      if ((insErr as { code?: string }).code === "23505")
        return { ok: true as const, deduped: true as const };
      return { ok: false as const, error: "insert_failed" as const };
    }
    return { ok: true as const };
  });

export const bindAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sessionId: string; clientId: string }) => {
    if (typeof input.sessionId !== "string" || input.sessionId.length < 10)
      throw new Error("invalid_session_id");
    if (typeof input.clientId !== "string" || !CLIENT_ID_RE.test(input.clientId))
      throw new Error("invalid_client_id");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase.rpc("bind_admin", {
      _session_id: data.sessionId,
      _client_id: data.clientId,
    });
    if (error) return { bound: false, reason: "rpc_error", admin_client_id: null };
    const row = Array.isArray(rows) ? rows[0] : rows;
    return {
      bound: Boolean(row?.bound),
      reason: (row?.reason as string) ?? "unknown",
      admin_client_id: (row?.admin_client_id as string | null) ?? null,
    };
  });
