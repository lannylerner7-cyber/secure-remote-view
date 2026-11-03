import { useEffect, useState } from "react";
import { validSourceSize, type SourceSize } from "@/lib/viewer-geometry";

/** Presentation metadata only. Does not start, stop or renegotiate media. */
export function useVideoSourceSize(video: HTMLVideoElement | null, sessionId: string | null): SourceSize | null {
  const [snapshot, setSnapshot] = useState<{
    video: HTMLVideoElement;
    sessionId: string;
    size: SourceSize | null;
  } | null>(null);

  useEffect(() => {
    if (!video || !sessionId) {
      setSnapshot(null);
      return;
    }
    const read = () => {
      const candidate = { width: video.videoWidth, height: video.videoHeight };
      const size = validSourceSize(candidate) ? candidate : null;
      setSnapshot((prev) =>
        prev?.video === video && prev.sessionId === sessionId
        && prev.size?.width === size?.width && prev.size?.height === size?.height
          ? prev
          : { video, sessionId, size });
    };
    read();
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    video.addEventListener("emptied", read);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
      video.removeEventListener("emptied", read);
    };
  }, [video, sessionId]);

  // Do not expose a previous session's dimensions before effect cleanup runs.
  return snapshot && snapshot.video === video && snapshot.sessionId === sessionId
    ? snapshot.size : null;
}
