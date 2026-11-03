/** Compatibility is explicit; never infer a receiver acknowledgement. */
export function usesLegacyActions(mediaMode: unknown, metadata: unknown): boolean {
  const meta = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  return mediaMode === "legacy" && meta.browser_video !== 1;
}

export function legacyMonitorMayBeDelivered(
  command: { kind: string; payload: unknown },
  authorization: { id: string; revokedAt: string | null; capabilities: { view: boolean } } | null,
  sessions: { id: string; state: string; media_mode?: string | null }[],
): boolean {
  const payload = command.payload && typeof command.payload === "object"
    ? command.payload as Record<string, unknown> : {};
  if (payload.protocol !== "legacy-monitor-v1") return true; // Existing native protocol, unchanged.
  return command.kind === "switch_monitor" && !!authorization && !authorization.revokedAt &&
    authorization.capabilities.view && payload.authorization_id === authorization.id &&
    sessions.some(s => s.id === payload.session_id && s.state === "active" && s.media_mode === "legacy");
}
