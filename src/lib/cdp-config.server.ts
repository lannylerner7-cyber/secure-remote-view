/**
 * CDP API-key config: read from server env and validate shape ONLY.
 * No SDK calls, no outbound requests, no key material returned.
 */

export type CdpValidation =
  | { ok: true }
  | { ok: false; reason: string };

const NAME_RE = /^organizations\/[0-9a-f-]{36}\/apiKeys\/[0-9a-f-]{36}$/i;

export function getCdpConfig(): { name: string | null; privateKey: string | null } {
  return {
    name: process.env.CDP_API_KEY_NAME ?? null,
    privateKey: process.env.CDP_API_KEY_PRIVATE_KEY ?? null,
  };
}

export function validateCdpConfig(): CdpValidation {
  const { name, privateKey } = getCdpConfig();
  if (!name) return { ok: false, reason: "CDP_API_KEY_NAME not set" };
  if (!privateKey) return { ok: false, reason: "CDP_API_KEY_PRIVATE_KEY not set" };
  if (!NAME_RE.test(name.trim())) {
    return { ok: false, reason: "CDP_API_KEY_NAME must be organizations/<uuid>/apiKeys/<uuid>" };
  }
  // Base64 decode + length check (CDP Ed25519 keys are 64 bytes).
  try {
    const buf = Buffer.from(privateKey.trim(), "base64");
    if (buf.length !== 64) {
      return { ok: false, reason: `CDP_API_KEY_PRIVATE_KEY decodes to ${buf.length} bytes, expected 64` };
    }
  } catch {
    return { ok: false, reason: "CDP_API_KEY_PRIVATE_KEY is not valid base64" };
  }
  return { ok: true };
}
