/** The stable admin identity is not a viewer-instance identity. */
export function tagPeerSignal(peerId: string, payload: unknown): Record<string, unknown> {
  return { ...(payload && typeof payload === "object" ? payload : {}), peer_id: peerId };
}

export function isCurrentPeerSignal(peerId: string, videoOnly: boolean, payload: unknown): boolean {
  const tag = payload && typeof payload === "object" ? (payload as { peer_id?: unknown }).peer_id : undefined;
  if (typeof tag === "string") return tag === peerId;
  return !videoOnly; // Unmodified legacy Agents do not echo viewer instance IDs.
}
