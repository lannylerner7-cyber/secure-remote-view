/**
 * Platform discriminator shared by server routes, the web console and tests.
 * `devices.platform` is the ONLY field platform-specific logic may branch on —
 * `devices.os` is free-text version info for display.
 * Mirrors the DB trigger `enforce_power_command_platform`.
 */
export type Platform = "windows" | "android";
export const PLATFORMS: readonly Platform[] = ["windows", "android"];

export function normalizePlatform(v: unknown): Platform {
  return v === "android" ? "android" : "windows";
}

export type PowerKind =
  | "wake"
  | "wake_agent"
  | "reboot"
  | "shutdown"
  | "lock"
  | "logoff"
  | "restart_stream"
  | "restart_agent"
  | "switch_monitor"
  | "restart_app";

export const POWER_KINDS_BY_PLATFORM: Record<Platform, readonly PowerKind[]> = {
  windows: [
    "wake",
    "wake_agent",
    "reboot",
    "shutdown",
    "lock",
    "logoff",
    "restart_stream",
    "restart_agent",
    "switch_monitor",
  ],
  // Device reboot remains unavailable until managed-device capability is
  // attested and validated by the service; app restart is a separate action.
  android: ["lock", "restart_stream", "restart_app"],
};

export function isPowerKindAllowed(platform: Platform, kind: string): boolean {
  return (POWER_KINDS_BY_PLATFORM[platform] as readonly string[]).includes(kind);
}

/** Release product each platform's agent pulls updates from. */
export function releaseProductFor(platform: Platform): "agent" | "android" {
  return platform === "android" ? "android" : "agent";
}

/** Numeric dotted-version compare ("1.10.0" > "1.9.3"). Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isUpdateAvailable(running: string | null | undefined, latest: string | null | undefined) {
  if (!running || !latest) return false;
  return compareVersions(latest, running) > 0;
}

/** Android pairing code: 8 chars, no ambiguous glyphs, shown as XXXX-XXXX. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function normalizeClaimCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 8) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export function generateClaimCode() {
  const random = new Uint32Array(8);
  globalThis.crypto.getRandomValues(random);
  let s = "";
  for (const value of random) s += CODE_ALPHABET[value % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
