import { supabase } from "@/integrations/supabase/client";
import {
  pinAssociatedData, validHelloPin, type SealedPin, type UnlockDevice, type UnlockTicket,
} from "@/shared/windows-unlock";

const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Only the device has the private key. Neither the API nor DB receives a PIN. */
export async function sealHelloPin(pin: string, device: UnlockDevice): Promise<SealedPin> {
  if (!validHelloPin(pin)) throw new Error("Enter a 4–127 character PIN, preserving any leading zeroes.");
  if (!device.enabled || !device.keyId || !device.publicKey || !device.authorizationId)
    throw new Error("Enable Windows unlock locally on this device first.");
  if (!globalThis.crypto?.subtle) throw new Error("A secure browser connection is required to encrypt the PIN.");
  const key = await crypto.subtle.importKey("spki", decode(device.publicKey),
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  if ((key.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 3072)
    throw new Error("The Agent supplied an unsupported encryption key.");
  const secret = new TextEncoder().encode(pin);
  const aes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const wrapping = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, aes);
    const contentKey = await crypto.subtle.importKey("raw", aes, "AES-GCM", false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({
      name: "AES-GCM", iv,
      additionalData: new TextEncoder().encode(pinAssociatedData(device.deviceId, device.authorizationId, device.keyId)),
      tagLength: 128,
    }, contentKey, secret);
    return { version: 1, algorithm: "RSA-OAEP-256+A256GCM", keyId: device.keyId,
      wrappedKey: encode(new Uint8Array(wrapping)), iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) };
  } finally { aes.fill(0); secret.fill(0); }
}

async function request<T>(deviceId: string, method: string, body?: unknown): Promise<T> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("Sign in again before managing Windows unlock.");
  const response = await fetch(`/api/public/admin/device/${encodeURIComponent(deviceId)}/unlock`, {
    method, cache: "no-store", credentials: "same-origin",
    headers: { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    // Never echo arbitrary upstream/provider response bodies into the UI.
    const code = (await response.json().catch(() => null))?.error;
    const messages: Record<string, string> = {
      unlock_setup_required: "Enable Windows unlock locally on this device first.",
      unlock_forbidden: "Your account cannot manage or use this device's Windows unlock.",
      unlock_unavailable: "Windows unlock is unavailable. Check its database migration and Agent setup.",
      unlock_rate_limited: "Wait before another unlock attempt. ConnectLive will not retry the PIN automatically.",
      unlock_key_changed: "The device encryption key changed. Reload before saving the PIN.",
      unlock_session_unavailable: "Use an active, authorized session with a ready command channel.",
      invalid_unlock_request: "The unlock request was invalid. Reload and try again.",
    };
    throw new Error(messages[code] ?? "Windows unlock could not complete. No automatic retry was made.");
  }
  return response.json() as Promise<T>;
}
export const getWindowsUnlock = (deviceId: string) => request<UnlockDevice>(deviceId, "GET");
export async function saveWindowsHelloPin(device: UnlockDevice, pin: string): Promise<UnlockDevice> {
  const sealedPin = await sealHelloPin(pin, device);
  return request<UnlockDevice>(device.deviceId, "PUT", {
    action: "save", authorizationId: device.authorizationId, sealedPin,
  });
}
export const removeWindowsHelloPin = (deviceId: string) =>
  request<UnlockDevice>(deviceId, "DELETE", { action: "forget" });
export const revokeWindowsUnlock = (deviceId: string) =>
  request<UnlockDevice>(deviceId, "DELETE", { action: "revoke" });
export const requestWindowsUnlock = (deviceId: string, sessionId: string, peerId: string) =>
  request<UnlockTicket>(deviceId, "POST", { action: "begin", sessionId, peerId });
