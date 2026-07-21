import { createHash } from "crypto";
import { adminClient } from "./server-supabase";

/**
 * Verify an incoming agent request against a stored device token hash.
 * Returns the device row on success, or null on failure.
 */
export async function verifyDevice(request: Request) {
  const deviceId = request.headers.get("x-device-id");
  const token = request.headers.get("x-device-token");
  if (!deviceId || !token) return null;

  const hash = createHash("sha256").update(token).digest("hex");
  const admin = adminClient();
  const { data } = await admin.from("devices").select("*").eq("device_id", deviceId).maybeSingle();
  if (!data) return null;
  const stored = (data.metadata as { token_hash?: string } | null)?.token_hash;
  if (!stored || stored !== hash) return null;
  return { admin, device: data };
}
