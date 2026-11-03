export type PairingCapabilities = {
  view: boolean;
  control: boolean;
  clipboard: boolean;
  files: boolean;
  recording: boolean;
};

export type PairingGrant = {
  noticeVersion: 1;
  mode: "attended" | "unattended";
  capabilities: PairingCapabilities;
};

export type PairingOffer = {
  id: string;
  disclosureId: string;
  organization: string;
  expiresAt: string;
  grant: PairingGrant;
};

export type IssuedPairing = PairingOffer & { code: string };

export const PAIRING_CAPABILITY_LABELS: Record<keyof PairingCapabilities, string> = {
  view: "View screen",
  control: "Keyboard/mouse control (includes privacy curtain in legacy clients)",
  clipboard: "Clipboard text",
  files: "File transfer",
  recording: "Record the shared session",
};

export const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === 12 && [...code].every((character) => PAIRING_ALPHABET.includes(character))
    ? code : null;
}
