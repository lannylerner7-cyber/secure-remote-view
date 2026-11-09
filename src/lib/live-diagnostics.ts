/** Safe transport metadata only. Never export the underlying RTCStatsReport. */
export const LIVE_TRANSPORT_PROTOCOL = 2;
export type LiveDiagnostics = {
  viewerProtocol: number;
  serverProtocol: number | null;
  state: string;
  signaling: string;
  ice: string;
  connection: string;
  inputChannel: string;
  filesChannel: string;
  clipboardChannel: string;
  relayConfigured: boolean;
  provider: string;
  localCandidate: string | null;
  remoteCandidate: string | null;
  transport: string | null;
  relayed: boolean | null;
  roundTripMs: number | null;
  bytesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  packetsLost: number;
  jitterMs: number | null;
  lastDecodedAgeMs: number | null;
  lastPresentedAgeMs: number | null;
  presentedFrames: number | null;
  codec: string | null;
  signalsApplied: number;
  catchup: "idle" | "reading" | "ok" | "unavailable";
  catchupMs: number | null;
};

const nonnegative = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const candidateType = (value: unknown): string | null =>
  ["host", "srflx", "prflx", "relay"].includes(value as string) ? value as string : null;

export function summarizeRtcStats(report: { forEach(cb: (row: Record<string, unknown>) => void): void }) {
  const rows: Record<string, unknown>[] = [];
  report.forEach(row => rows.push(row));
  const transport = rows.find(row => row.type === "transport" && row.selectedCandidatePairId);
  const pair = rows.find(row => row.type === "candidate-pair" &&
    (transport ? row.id === transport.selectedCandidatePairId :
      row.selected === true || (row.nominated === true && row.state === "succeeded")));
  const local = rows.find(row => row.type === "local-candidate" && row.id === pair?.localCandidateId);
  const remote = rows.find(row => row.type === "remote-candidate" && row.id === pair?.remoteCandidateId);
  const inbound = rows.filter(row => row.type === "inbound-rtp" &&
    (row.kind === "video" || row.mediaType === "video"));
  const maximum = (key: string) => Math.max(0, ...inbound.map(row => nonnegative(row[key]) ?? 0));
  const localCandidate = candidateType(local?.candidateType);
  const remoteCandidate = candidateType(remote?.candidateType);
  const protocol = local?.relayProtocol ?? local?.protocol ?? remote?.protocol;
  const rtt = nonnegative(pair?.currentRoundTripTime);
  const jitter = inbound.map(row => nonnegative(row.jitter)).find(value => value !== null);
  const codecId = inbound.find(row => row.codecId)?.codecId;
  const codecRow = rows.find(row => row.type === "codec" && row.id === codecId);
  const mime = typeof codecRow?.mimeType === "string" ? codecRow.mimeType.toUpperCase() : "";
  return {
    localCandidate, remoteCandidate,
    transport: ["udp", "tcp", "tls"].includes(protocol as string) ? protocol as string : null,
    relayed: localCandidate || remoteCandidate ? localCandidate === "relay" || remoteCandidate === "relay" : null,
    roundTripMs: rtt === null ? null : Math.round(rtt * 1000),
    bytesReceived: maximum("bytesReceived"),
    framesDecoded: maximum("framesDecoded"),
    framesDropped: maximum("framesDropped"),
    packetsLost: maximum("packetsLost"),
    jitterMs: jitter == null ? null : Math.round(jitter * 1000),
    codec: mime === "VIDEO/H264" ? "H264" : mime === "VIDEO/VP8" ? "VP8" : null,
  };
}
