export type VideoFrameHealth = { decoding: boolean; fps: number };

/** ICE, cursor updates and a nonzero historical frame count are not fresh video. */
export function observeVideoFrames(
  video: HTMLVideoElement,
  onHealth: (health: VideoFrameHealth) => void,
  staleAfterMs = 5_000,
): () => void {
  let stopped = false;
  let callbackId: number | null = null;
  let lastProgressAt: number | null = null;
  let lastSampleAt = performance.now();
  let sampleFrames = 0;
  let decoding = false;
  let previousTotal = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
  const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";

  onHealth({ decoding: false, fps: 0 });

  function progress(frames: number) {
    lastProgressAt = performance.now();
    sampleFrames += frames;
    if (!decoding) {
      decoding = true;
      onHealth({ decoding: true, fps: 0 });
    }
  }

  function frame() {
    if (stopped) return;
    progress(1);
    callbackId = video.requestVideoFrameCallback(frame);
  }
  if (hasFrameCallback) callbackId = video.requestVideoFrameCallback(frame);

  const timer = window.setInterval(() => {
    if (stopped) return;
    if (!hasFrameCallback) {
      const total = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      // A replacement track may reset the counter. Only new progress counts.
      if (total > previousTotal) progress(total - previousTotal);
      previousTotal = total;
    }
    const now = performance.now();
    decoding = lastProgressAt !== null && now - lastProgressAt < staleAfterMs;
    const fps = decoding
      ? Math.round(sampleFrames * 1_000 / Math.max(1, now - lastSampleAt))
      : 0;
    sampleFrames = 0;
    lastSampleAt = now;
    onHealth({ decoding, fps });
  }, 1_000);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
  };
}
