/** Codecs and routes are independent: ICE races direct and TURN in "all" mode. */
export const MEDIA_PROFILES = [
  { codec: "h264-preferred", route: "all", label: "H.264 / VP8 · direct or TURN" },
  { codec: "vp8", route: "all", label: "VP8 · direct or TURN" },
  { codec: "h264-preferred", route: "relay", label: "H.264 / VP8 · TURN only" },
  { codec: "vp8", route: "relay", label: "VP8 · TURN only" },
] as const;

export type MediaProfile = (typeof MEDIA_PROFILES)[number];
export type MediaFailure = {
  reason: "network" | "media" | "signaling" | "authorization" | "relay-unavailable" | "unsupported-codec";
  retryable: boolean;
  retryAfterMs?: number;
};
export type MediaProgress = { framesDecoded: number; codec: string | null; path: string | null };

/** Keep repair codecs, but never offer H.264 in an explicit VP8-only attempt. */
export function preferredVideoCodecs<T extends { mimeType: string }>(
  codecs: T[], preference: MediaProfile["codec"],
): T[] {
  const matching = (name: string) => codecs.filter(c => c.mimeType.toLowerCase() === `video/${name}`);
  const vp8 = matching("vp8");
  const h264 = preference === "vp8" ? [] : matching("h264");
  if (!h264.length && !vp8.length) return [];
  return [...h264, ...vp8, ...matching("rtx"), ...matching("red"), ...matching("ulpfec")];
}

export function recoveryDelay(failures: number, minimum = 0): number {
  const delay = failures < 4 ? 1000 * 2 ** Math.max(0, failures - 1)
    : Math.min(120_000, 30_000 * 2 ** Math.floor((failures - 4) / 4));
  return Math.max(delay, minimum);
}

/** A failed network path is not evidence that the negotiated codec is broken. */
export function recoveryProfileIndex(current: number, reason: MediaFailure["reason"]): number {
  const profile = MEDIA_PROFILES[current];
  if (profile && ["network", "signaling", "relay-unavailable"].includes(reason)) {
    const alternative = MEDIA_PROFILES.findIndex(candidate =>
      candidate.codec === profile.codec && candidate.route !== profile.route);
    if (alternative >= 0) return alternative;
  }
  return (current + 1) % MEDIA_PROFILES.length;
}

export function bindingDenied(reason: string | undefined): boolean {
  return ["forbidden", "not_found", "not_authorized", "not_active"].includes(reason ?? "");
}
