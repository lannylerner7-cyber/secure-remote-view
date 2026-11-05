/** JPEG diagnosis uses a new legacy-media session; video sessions stay immutable. */
export function selectSessionMediaMode(
  platform: string | null | undefined,
  metadata: unknown,
  jpegDiagnostic = false,
): "video" | "legacy" {
  const modernWindows = platform === "windows" && !!metadata &&
    typeof metadata === "object" && (metadata as Record<string, unknown>).browser_video === 1;
  if (jpegDiagnostic && !modernWindows) {
    throw new Error("JPEG diagnosis requires a browser-capable Windows Agent.");
  }
  return modernWindows && !jpegDiagnostic ? "video" : "legacy";
}

/** Never invite a replacement when ending the previous session failed. */
export async function replaceWithJpegDiagnostic(
  endCurrent: () => Promise<boolean>,
  inviteReplacement: () => Promise<boolean>,
): Promise<boolean> {
  if (!await endCurrent()) return false;
  return inviteReplacement();
}
