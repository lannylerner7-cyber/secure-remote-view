import { isCurrentPeerSignal } from "./peer-signals";

export type RemoteSignal = {
  id: number;
  from_side: string;
  kind: string;
  payload: unknown;
  admin_client_id: string | null;
};

/**
 * Realtime is a notification transport, not durable delivery. Share this inbox
 * with catch-up reads so overlapping deliveries are applied once. In particular,
 * a later ICE row must not hide an earlier answer that commits/delivers late.
 */
export function createRemoteSignalInbox(options: {
  peerId: string;
  clientId: string;
  strict: boolean;
  minimumId: number;
  active(): boolean;
  apply(row: RemoteSignal): Promise<void>;
  applied(id: number): void;
}) {
  const seen = new Set<number>();
  const pending = new Map<number, Promise<void>>();
  let stopped = false;
  const active = () => !stopped && options.active();

  function accept(value: unknown): Promise<void> {
    if (!active() || !value || typeof value !== "object") return Promise.resolve();
    const row = value as RemoteSignal;
    if (!Number.isSafeInteger(row.id) || row.id <= options.minimumId ||
        row.from_side !== "agent" ||
        !["answer", "ice", "bye", "terminated"].includes(row.kind) ||
        (row.admin_client_id != null && row.admin_client_id !== options.clientId) ||
        !isCurrentPeerSignal(options.peerId, options.strict, row.payload) ||
        seen.has(row.id)) return Promise.resolve();
    const existing = pending.get(row.id);
    if (existing) return existing;
    // Never evict an applied answer and then reapply it from the next snapshot.
    if (seen.size + pending.size >= 512)
      return Promise.reject(new Error("Signal inbox capacity exceeded"));

    const work = Promise.resolve().then(async () => {
      if (!active()) return;
      await options.apply(row);
      if (!active()) return;
      seen.add(row.id);
      options.applied(row.id);
    }).finally(() => { pending.delete(row.id); });
    pending.set(row.id, work);
    return work;
  }

  return {
    accept,
    count: () => seen.size,
    close() { stopped = true; seen.clear(); },
  };
}
