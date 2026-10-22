import { createHash, randomUUID } from "node:crypto";
import { mailErrorReason } from "./smtp.server";

export type DeliveryResult = { ok: boolean; reason?: string; duplicate?: boolean; warning?: string; acceptedAt?: string };

/**
 * Durable CAS delivery claim using the existing audit table; no schema change.
 * SMTP is not transactional with SQL: an interrupted attempt is deliberately
 * uncertain, never automatically retried. An operator can explicitly retry
 * after the two-minute lease, accepting the possibility of a duplicate.
 */
export async function deliverOnce(
  key: string,
  send: () => Promise<void>,
  force = false,
): Promise<DeliveryResult> {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const hex = createHash("sha256").update(`connectlive-mail-v1:${key}`).digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const { data: previous, error: readError } = await db.from("audit_logs")
    .select("detail").eq("id", id).maybeSingle();
  if (readError) return { ok: false, reason: "delivery_store_unavailable" };
  const prior = previous?.detail as { state?: string; attempt?: string; at?: number; acceptedAt?: string } | undefined;
  if (prior?.state === "accepted" && !force) return { ok: true, duplicate: true, acceptedAt: prior.acceptedAt };
  if (prior && (!force || Date.now() - (prior.at ?? Date.now()) < 120_000)) {
    return { ok: false, reason: "delivery_in_progress_or_uncertain" };
  }
  const detail = { state: "sending", attempt: randomUUID(), at: Date.now() };
  if (prior) {
    if (!prior.attempt) return { ok: false, reason: "delivery_store_invalid" };
    const { data, error } = await db.from("audit_logs").update({ detail })
      .eq("id", id).eq("detail->>attempt", prior.attempt).select("id");
    if (error || !data?.length) return { ok: false, reason: "delivery_claim_conflict" };
  } else {
    const { error } = await db.from("audit_logs")
      .insert({ id, event: "mail.delivery_claim", detail });
    if (error) return { ok: false, reason: error.code === "23505" ? "delivery_claim_conflict" : "delivery_store_unavailable" };
  }
  try {
    await send();
  } catch (error) {
    // Do not release the claim: even a lost final SMTP response can mean accepted.
    return { ok: false, reason: mailErrorReason(error) };
  }
  const acceptedAt = new Date().toISOString();
  const { error } = await db.from("audit_logs")
    .update({ detail: { ...detail, state: "accepted", acceptedAt } })
    .eq("id", id).eq("detail->>attempt", detail.attempt);
  return { ok: true, acceptedAt, ...(error ? { warning: "delivery_log_failed" } : {}) };
}
