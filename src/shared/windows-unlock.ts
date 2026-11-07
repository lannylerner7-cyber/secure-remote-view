/** Versioned extension to pairing v1. Absence never grants lock-screen access. */
export const UNLOCK_VERSION = 1 as const;
export type SealedPin = {
  version: 1;
  algorithm: "RSA-OAEP-256+A256GCM";
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
};
export type UnlockDevice = {
  deviceId: string;
  enabled: boolean;
  authorizationId: string | null;
  keyId: string | null;
  publicKey: string | null;
  windowsAccount: string | null;
  locked: boolean | null;
  helperReady: boolean;
  hasPin: boolean;
  credentialVersion: string | null;
  lastSeenAt: string | null;
};
export type UnlockTicket = { requestId: string; expiresAt: string };
export type UnlockPhase = "idle" | "starting" | "ready" | "submitted" | "unlocked" | "cancelled" | "blocked";
export type UnlockState = {
  phase: UnlockPhase;
  requestId: string | null;
  reason: string | null;
};
export const EMPTY_UNLOCK: UnlockState = { phase: "idle", requestId: null, reason: null };
export const UNLOCK_PIN_NOTICE =
  "Enter this device's Windows Hello PIN explicitly. ConnectLive does not read Windows Hello. " +
  "Saving a reusable PIN reduces the protection of a device-only PIN: authorized operators can use it to sign in. " +
  "The PIN is encrypted for this enrolled Agent before it leaves this screen. It cannot be revealed or downloaded.";
export function pinAssociatedData(deviceId: string, authorizationId: string, keyId: string): string {
  return `ConnectLive.WindowsHelloPin.v1\n${deviceId.toLowerCase()}\n${authorizationId.toLowerCase()}\n${keyId.toLowerCase()}`;
}
export function validHelloPin(pin: string): boolean {
  // Do not normalize, trim or convert to a number: leading zeroes matter.
  return /^[\x20-\x7e]{4,127}$/.test(pin);
}
