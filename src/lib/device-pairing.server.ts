import { createHash, randomBytes } from "node:crypto";
import { parseGrantRequest } from "@/lib/authorization.server";
import { PAIRING_ALPHABET, type PairingOffer } from "@/shared/device-pairing";

export const hashPairingValue = (value: string) => createHash("sha256").update(value).digest("hex");
export function generatePairingCode(): string {
  const raw = [...randomBytes(12)].map((byte) => PAIRING_ALPHABET[byte & 31]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function parsePairingOffer(value: unknown): PairingOffer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const grant = parseGrantRequest(row.grant);
  if (typeof row.id !== "string" || !uuid.test(row.id) ||
    typeof row.disclosureId !== "string" || !uuid.test(row.disclosureId) ||
    typeof row.organization !== "string" || !row.organization.trim() || row.organization.length > 120 ||
    typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt)) ||
    !grant || !grant.capabilities.view) return null;
  return { id: row.id, disclosureId: row.disclosureId, organization: row.organization,
    expiresAt: row.expiresAt, grant };
}

export function pairingError(message: string | undefined): string {
  const messages: Record<string, string> = {
    pairing_forbidden: "You cannot issue pairing codes for this license.",
    pairing_identity_required: "Link a license owner and set its organization name before pairing.",
    pairing_license_inactive: "This license is not currently active.",
    pairing_limit_reached: "Five codes are already active for this license. Revoke a code or wait for expiry.",
    pairing_seats_full: "This license has no free device seats.",
  };
  return messages[message ?? ""] ?? "Pairing is unavailable. Check that the pairing migration is installed.";
}

/** Bound the actual stream, not just a caller-supplied Content-Length. */
export async function readPairingJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw new Error("request_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}
