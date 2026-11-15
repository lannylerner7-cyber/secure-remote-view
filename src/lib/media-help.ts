// Wording for the live viewer's "?" popup. Presentation only: it reports the
// transport state the viewer already tracks and never changes that state.

export type MediaHelpInput = {
  /** A decoded video frame from the current peer is being presented. */
  videoDecoding: boolean;
  /** An authorized, recent JPEG picture is available for an active session. */
  jpegFresh: boolean;
  /** The technician paused this viewer locally. */
  viewerPaused: boolean;
  rtcState: string;
  recovery: {
    phase: "connecting" | "live" | "waiting" | "finishing-recording" | "stopped";
    profile: { label: string };
    attempt: number;
    codec: string | null;
    path: string | null;
  } | null;
};

export type MediaHelpRow = { label: string; value: string };

export type MediaHelp = {
  /** True when the technician is not looking at live video and did not pause it. */
  attention: boolean;
  /** One sentence describing what is on screen right now. */
  now: string;
  /** Connection, codec, route and retry facts, in display order. */
  rows: MediaHelpRow[];
};

/** Where the Agent writes its logs on the remote Windows PC. */
export const AGENT_LOG_PATH = "%LOCALAPPDATA%\\ConnectLive\\logs";

const CONNECTION: Record<string, string> = {
  idle: "Not started",
  connecting: "Connecting",
  connected: "Connected",
  failed: "Failed",
  superseded: "Taken over by another viewer",
};

export function describeMediaHelp(input: MediaHelpInput): MediaHelp {
  const { videoDecoding, jpegFresh, viewerPaused, rtcState, recovery } = input;
  const stopped = recovery?.phase === "stopped";
  const now = viewerPaused
    ? "This viewer is paused on your computer. Resume the viewer to see the remote screen again."
    : videoDecoding
      ? "Live video is playing. JPEG is on standby and is not being shown."
      : jpegFresh
        ? "Showing JPEG pictures while video recovers automatically. Use 1:1 for pixel-for-pixel text."
        : "Waiting for an authorized video stream or a fresh JPEG picture. Viewing permission is still required.";

  const rows: MediaHelpRow[] = [
    { label: "Video connection", value: CONNECTION[rtcState] ?? rtcState },
  ];
  if (recovery?.phase === "live") {
    rows.push({ label: "Codec", value: recovery.codec ?? "Not yet reported" });
    rows.push({
      label: "Route",
      value: recovery.path === "relay" ? "TURN relay" : recovery.path ? "Direct connection" : "Not yet reported",
    });
  } else if (stopped) {
    rows.push({
      label: "Retries",
      value: "Stopped because viewing permission or viewer ownership changed.",
    });
  } else if (recovery?.phase === "finishing-recording") {
    rows.push({ label: "Retries", value: "Saving the recording segment before reconnecting." });
  } else if (recovery) {
    const waiting = recovery.phase === "waiting";
    rows.push({
      label: "Retries",
      value: `${waiting ? "Next automatic retry" : "Trying"}: ${recovery.profile.label} · attempt ${recovery.attempt + (waiting ? 1 : 0)}`,
    });
  }

  return { attention: stopped || (!viewerPaused && !videoDecoding), now, rows };
}
