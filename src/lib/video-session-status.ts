import type { WebRtcState } from "./webrtc-live";

export function videoSessionStatus(input: {
  sessionState: string; supported: boolean; viewerPaused: boolean;
  deviceOnline: boolean; rtcState: WebRtcState; decoding: boolean; attemptAgeMs: number;
}) {
  const status =
    input.sessionState === "ended" ? ["ended", "Session ended"] :
    input.sessionState === "declined" ? ["ended", "Session declined"] :
    input.sessionState === "paused" ? ["paused", "Sharing paused"] :
    input.sessionState !== "active" ? ["waiting", "Waiting for authorized Agent"] :
    !input.supported ? ["unsupported", "This browser does not support WebRTC"] :
    input.rtcState === "superseded" ? ["disconnected", "Another viewer took over"] :
    !input.deviceOnline ? ["disconnected", "Agent disconnected"] :
    input.rtcState === "failed" ? ["disconnected", "Video disconnected — reconnect viewer"] :
    input.viewerPaused ? ["paused", "Viewer paused — sharing continues"] :
    input.decoding ? ["live", "Live video"] :
    input.rtcState === "connected" && input.attemptAgeMs >= 8000 ? ["stalled", "Video stalled — no decoded frames"] :
    ["connecting", "Connecting video"];
  return {
    key: status[0],
    label: status[1],
    tone: status[0] === "live" ? "bg-emerald-400" :
      ["connecting", "waiting", "paused"].includes(status[0]) ? "bg-amber-400" : "bg-rose-500",
  };
}
