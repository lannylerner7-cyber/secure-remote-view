/** A filename must describe the actual recorder container, not the input codec. */
export function recordingExtension(mimeType: string): "webm" | "mp4" | null {
  const container = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (container === "video/webm") return "webm";
  if (container === "video/mp4") return "mp4";
  return null;
}

export function recordingFilename(sessionId: string, mimeType: string, timestamp = Date.now()): string {
  const extension = recordingExtension(mimeType);
  if (!extension) throw new Error("The recording has an unsupported container. No mislabeled file was downloaded.");
  return `connectlive-${sessionId.slice(0, 8)}-${timestamp}.${extension}`;
}

export type RecordingIssue =
  | "no_video" | "unsupported_browser" | "authorization_denied"
  | "authorization_unavailable" | "authorization_expired" | "authorization_changed"
  | "encoder_failed" | "finalization_failed" | "no_frames";

export function recordingIssueMessage(issue: RecordingIssue | null): string {
  switch (issue) {
    case "no_video": return "Wait for live video before recording. Still pictures cannot be recorded.";
    case "unsupported_browser": return "This browser cannot encode a supported recording. Try an up-to-date Chrome, Edge or Firefox.";
    case "authorization_denied": return "Recording permission was denied or withdrawn for this session.";
    case "authorization_unavailable": return "Recording permission could not be verified within three seconds. Check the gateway connection, then try again.";
    case "authorization_expired": return "Recording stopped because its five-second authorization lease expired. Start a new recording after the connection recovers.";
    case "authorization_changed": return "Recording stopped because the session authorization changed.";
    case "encoder_failed": return "The browser's video recorder failed. No recording was saved.";
    case "finalization_failed": return "The browser did not finish the recording. No incomplete file was downloaded.";
    case "no_frames": return "The recording contains no video data. Wait for advancing video, then try again.";
    default: return "Recording is unavailable. Check live video and recording permission.";
  }
}
