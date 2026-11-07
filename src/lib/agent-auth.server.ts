import { createHash } from "crypto";
import { adminClient } from "./server-supabase";
import type { Database } from "@/integrations/supabase/types";

type DeviceVerificationFailure = { kind: "unauthorized" } | { kind: "unavailable" };
export type DeviceVerification = DeviceVerificationFailure | {
  kind: "verified";
  admin: ReturnType<typeof adminClient>;
  device: Database["public"]["Tables"]["devices"]["Row"];
};

/** A failed lookup is not evidence that a saved device credential is invalid. */
export async function verifyDevice(request: Request): Promise<DeviceVerification> {
  const deviceId = request.headers.get("x-device-id");
  const token = request.headers.get("x-device-token");
  if (!deviceId || !token) return { kind: "unauthorized" };

  const hash = createHash("sha256").update(token).digest("hex");
  try {
    const admin = adminClient();
    const { data, error } = await admin.from("devices").select("*").eq("device_id", deviceId).maybeSingle();
    if (error) return { kind: "unavailable" };
    if (!data) return { kind: "unauthorized" };
    const stored = (data.metadata as { token_hash?: string } | null)?.token_hash;
    if (!stored || stored !== hash) return { kind: "unauthorized" };
    return { kind: "verified", admin, device: data };
  } catch {
    // Transport/configuration exceptions can contain URLs, credentials or
    // upstream response text. Neither return nor log them.
    return { kind: "unavailable" };
  }
}

/** All callers must handle the explicit failure before accessing the device. */
export function deviceAuthFailure(result: DeviceVerificationFailure, format: "text" | "json" = "text"): Response {
  const error = result.kind === "unavailable" ? "device_lookup_unavailable" : "unauthorized";
  const init = {
    status: result.kind === "unavailable" ? 503 : 401,
    headers: { "cache-control": "no-store" },
  };
  return format === "json" ? Response.json({ error }, init) : new Response(error, init);
}
