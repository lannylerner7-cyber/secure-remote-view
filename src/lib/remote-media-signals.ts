type RemoteMediaPeer = Pick<RTCPeerConnection, "setRemoteDescription" | "addIceCandidate">;

/**
 * Trickle ICE can precede the answer, or arrive while setRemoteDescription is
 * still pending. Realtime callbacks are concurrent, so ordering at the sender
 * alone is insufficient. Keep descriptions and candidates in one local queue.
 */
export function createRemoteMediaSignals(peer: RemoteMediaPeer, active: () => boolean) {
  let closed = false;
  let epoch = 0;
  let waitingForAnswer = true;
  let pending: RTCIceCandidateInit[] = [];
  let tail: Promise<void> = Promise.resolve();
  const maxPendingCandidates = 256;

  function schedule(work: (valid: () => boolean) => Promise<void>) {
    const current = epoch;
    const valid = () => !closed && active() && current === epoch;
    const result = tail.then(async () => {
      if (valid()) await work(valid);
    });
    // A rejected candidate must not prevent a subsequent answer/candidate.
    tail = result.catch(() => undefined);
    return result;
  }

  return {
    expectAnswer() {
      epoch++;
      waitingForAnswer = true;
      pending = [];
    },
    answer(description: RTCSessionDescriptionInit) {
      return schedule(async (valid) => {
        await peer.setRemoteDescription({ type: description.type, sdp: description.sdp });
        if (!valid()) return;
        waitingForAnswer = false;
        const candidates = pending;
        pending = [];
        let firstFailure: unknown;
        for (const candidate of candidates) {
          if (!valid()) return;
          try { await peer.addIceCandidate(candidate); }
          catch (error) { firstFailure ??= error; }
        }
        // Report failure without losing the other valid queued candidates.
        if (firstFailure !== undefined) throw firstFailure;
      });
    },
    ice(candidate: RTCIceCandidateInit) {
      return schedule(async () => {
        if (waitingForAnswer) {
          if (pending.length >= maxPendingCandidates)
            throw new Error("Remote ICE candidate queue limit reached");
          pending.push(candidate);
        } else {
          await peer.addIceCandidate(candidate);
        }
      });
    },
    close() {
      closed = true;
      epoch++;
      pending = [];
    },
  };
}
