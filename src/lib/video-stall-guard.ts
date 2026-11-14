/**
 * A keyframe request is only a recovery hint, never proof of healthy media.
 * Give one supported peer four seconds, then use the existing reconnection
 * path. Only new decoded/presented frames reset this budget.
 */
export function createVideoStallGuard(requestKeyFrame: () => boolean) {
  let progressAt = -Infinity;
  let requestedAt: number | null = null;
  return {
    reset() { progressAt = -Infinity; requestedAt = null; },
    check(now: number, latestFrameAt: number, silenceMs = 8_000): "wait" | "keyframe" | "recover" {
      if (latestFrameAt > progressAt) {
        progressAt = latestFrameAt;
        requestedAt = null;
      }
      if (requestedAt !== null) return now - requestedAt < 4_000 ? "wait" : "recover";
      if (now - progressAt < silenceMs) return "wait";
      if (!requestKeyFrame()) return "recover";
      requestedAt = now;
      return "keyframe";
    },
  };
}
