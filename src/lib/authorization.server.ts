import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const CAPABILITIES = ["view", "control", "clipboard", "files", "recording"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type GrantRequest = {
  noticeVersion: 1;
  mode: "attended" | "unattended";
  capabilities: Record<Capability, boolean>;
};
export type Authorization = GrantRequest & {
  id: string;
  recordedAt: string;
  revokedAt: string | null;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(v).length === expected.length && expected.every((key) => Object.hasOwn(v, key));

export function parseGrantRequest(value: unknown): GrantRequest | null {
  if (!object(value) || !keys(value, ["noticeVersion", "mode", "capabilities"])) return null;
  if (value.noticeVersion !== 1 || !["attended", "unattended"].includes(value.mode as string))
    return null;
  if (!object(value.capabilities) || !keys(value.capabilities, CAPABILITIES)) return null;
  if (!CAPABILITIES.every((key) => typeof (value.capabilities as Record<string, unknown>)[key] === "boolean"))
    return null;
  if (value.capabilities.control && !value.capabilities.view) return null;
  return value as GrantRequest;
}

export function parseAuthorization(value: unknown): Authorization | null {
  if (!object(value) || !keys(value, ["id", "noticeVersion", "mode", "capabilities", "recordedAt", "revokedAt"]))
    return null;
  if (!parseGrantRequest({ noticeVersion: value.noticeVersion, mode: value.mode, capabilities: value.capabilities }))
    return null;
  if (typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id))
    return null;
  if (typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt))) return null;
  if (value.revokedAt !== null && (typeof value.revokedAt !== "string" || !Number.isFinite(Date.parse(value.revokedAt))))
    return null;
  return value as Authorization;
}

/** Missing migrations/RPC errors are denial, never a legacy timestamp fallback. */
export async function currentAuthorization(admin: SupabaseClient<Database>, deviceId: string) {
  const { data, error } = await admin.rpc("device_authorization", { _device_id: deviceId });
  if (error) throw new Error("authorization_unavailable");
  if (data === null) return null;
  const grant = parseAuthorization(data);
  if (!grant) throw new Error("authorization_malformed");
  return grant;
}

export async function sessionAuthorized(
  client: SupabaseClient<Database>, sessionId: string, capability: Capability = "view",
): Promise<boolean> {
  const { data, error } = await client.rpc("session_authorized", {
    _session_id: sessionId, _capability: capability,
  });
  return !error && data === true;
}

export function inputCapability(kind: string): Capability | "safety" | null {
  if (["release_inputs", "curtain_off"].includes(kind)) return "safety";
  if (["restart_stream", "switch_monitor"].includes(kind)) return "view";
  if (kind === "clipboard") return "clipboard";
  if (["mousemove", "mousemove_rel", "mousedown", "mouseup", "wheel", "click",
    "keydown", "keyup", "unicode_text", "key_sequence", "curtain_on"].includes(kind)) return "control";
  return null;
}
