export type InputPausePhase = "unknown" | "unsupported" | "pausing" | "paused" | "resuming" | "active";

export interface InputPauseState {
  supported: boolean;
  phase: InputPausePhase;
  paused: boolean | null;
  epoch: string | null;
  revision: number;
  reason: string | null;
}

export const EMPTY_INPUT_PAUSE: InputPauseState = {
  supported: false, phase: "unknown", paused: null, epoch: null, revision: -1, reason: null,
};

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ordinaryKinds = new Set([
  "mousemove", "mousemove_rel", "mousedown", "mouseup", "click", "wheel",
  "keydown", "keyup", "key_sequence", "unicode_text", "text",
]);
type WireState = {
  paused: boolean; released: boolean; epoch: string; revision: number; processId: string; peerId: string; controllerId: string;
};

/** An Agent receipt, not send() or a local button state, confirms the input barrier.
 * This restriction never grants control or changes the privacy curtain.
 */
export function createBrowserInputPause(options: {
  sessionId: string;
  authorizationId: string | null;
  peerId?: string;
  controllerId?: string;
  mode(): "view" | "control" | null;
  send(message: unknown): boolean;
  uncertain(): void;
}) {
  let state: InputPauseState = { ...EMPTY_INPUT_PAUSE };
  let wire: WireState | null = null;
  let locallyBlocked = false;
  let supportedOnce = false;
  const listeners = new Set<(state: InputPauseState) => void>();
  let pending: {
    id: string; paused: boolean; revision: number;
    finish(error?: Error, uncertain?: boolean): void;
  } | null = null;

  function publish(patch: Partial<InputPauseState>) {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener(state));
  }

  function parse(value: Record<string, unknown>): WireState | null {
    if (value.input_pause_protocol !== 1 || value.input_pause_supported !== true ||
        typeof value.input_paused !== "boolean" ||
        typeof value.input_release_confirmed !== "boolean" ||
        typeof value.input_epoch !== "string" || !uuid.test(value.input_epoch) ||
        !Number.isSafeInteger(value.input_revision) || (value.input_revision as number) < 0 ||
        typeof value.process_id !== "string" || !uuid.test(value.process_id) ||
        typeof value.peer_id !== "string" || !uuid.test(value.peer_id) ||
        typeof value.controller_id !== "string" || value.controller_id.length > 160 ||
        !value.controller_id ||
        (options.peerId !== undefined && value.peer_id !== options.peerId) ||
        (options.controllerId !== undefined && value.controller_id !== options.controllerId)) return null;
    return {
      paused: value.input_paused, released: value.input_release_confirmed,
      epoch: value.input_epoch, revision: value.input_revision as number,
      processId: value.process_id, peerId: value.peer_id, controllerId: value.controller_id,
    };
  }

  function receive(value: Record<string, unknown>) {
    if (value.session_id !== options.sessionId || options.authorizationId === null ||
        value.authorization_id !== options.authorizationId ||
        (value.kind !== "permission_status" && value.kind !== "input_pause_status")) return;
    const next = parse(value);
    if (!next) {
      if (value.kind === "permission_status" && !supportedOnce &&
          value.input_pause_supported !== true &&
          (value.mode === "view" || value.mode === "control")) {
        publish({ ...EMPTY_INPUT_PAUSE, phase: "unsupported", reason: "This Agent does not support confirmed input pause." });
      }
      return;
    }
    if (wire && (next.peerId !== wire.peerId || next.processId !== wire.processId ||
        next.controllerId !== wire.controllerId || next.revision < wire.revision ||
        (next.revision === wire.revision && next.epoch !== wire.epoch))) return;
    supportedOnce = true;
    const request = pending;
    // An unrelated permission notification is not the result of this operation.
    if (request && value.request_id !== request.id) return;
    wire = next;
    if (request) {
      if (value.kind !== "input_pause_status" || value.action !== "input_pause") return;
      if (value.status !== "applied" || next.paused !== request.paused ||
          !next.released || next.revision <= request.revision || (!request.paused && options.mode() !== "control")) {
        locallyBlocked = true;
        const confirmedPaused = next.paused && next.released && value.reason !== "secure_input_active";
        publish({ supported: true, paused: next.paused, epoch: next.epoch, revision: next.revision,
          phase: confirmedPaused ? "paused" : "unknown",
          reason: "The Agent rejected this input-state change. Input remains blocked here." });
        request.finish(new Error("The Agent could not confirm input state. Check current control permission."), !next.paused);
        return;
      }
      locallyBlocked = next.paused;
      publish({ supported: true, phase: next.paused ? "paused" : "active", paused: next.paused,
        epoch: next.epoch, revision: next.revision, reason: null });
      request.finish();
      return;
    }
    if (next.paused) locallyBlocked = true;
    publish({
      supported: true, paused: next.paused, epoch: next.epoch, revision: next.revision,
      phase: next.paused ? next.released ? "paused" : "unknown" : locallyBlocked ? "unknown" : "active",
      reason: !next.released ? "The Agent has not confirmed releasing held keys and buttons." :
        !next.paused && locallyBlocked ? "Resume control explicitly to enable input here." : null,
    });
  }

  function setPaused(paused: boolean, signal?: AbortSignal): Promise<void> {
    if (!state.supported || !wire)
      return Promise.reject(new Error("This Agent has not confirmed support for input pause."));
    if (pending) return Promise.reject(new Error("An input-state change is already awaiting the Agent."));
    if (signal?.aborted) return Promise.reject(new Error("Input-state request cancelled."));
    if (!paused && options.mode() !== "control")
      return Promise.reject(new Error("Take control before resuming remote input."));
    // Close the local sender synchronously, before any asynchronous work.
    locallyBlocked = true;
    const expected = { ...wire };
    publish({ phase: paused ? "pausing" : "resuming", reason: null });
    return new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (error?: Error, uncertain = false) => {
        if (pending?.id !== id) return;
        pending = null;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) {
          locallyBlocked = true;
          if (uncertain) publish({ phase: "unknown", paused: null, reason: error.message });
          reject(error);
          // A possibly late resume must not survive an abandoned operation.
          // Closing the peer makes the receiver's disconnect barrier apply.
          if (uncertain) options.uncertain();
        } else resolve();
      };
      const abort = () => finish(new Error("Input-state request cancelled; remote state is unconfirmed."), true);
      const timer = setTimeout(() => finish(new Error(
        "The Agent did not confirm input state. Input is blocked here; reconnect before resuming."
      ), true), 6500);
      pending = { id, paused, revision: expected.revision, finish };
      signal?.addEventListener("abort", abort, { once: true });
      if (!options.send({ kind: "input_pause", payload: {
        request_id: id, authorization_id: options.authorizationId, paused,
        peer_id: expected.peerId, process_id: expected.processId, controller_id: expected.controllerId,
        input_epoch: expected.epoch, input_revision: expected.revision,
      } })) finish(new Error("The input-state request was not sent. Remote state is unconfirmed."), true);
    });
  }

  function allowed() {
    return options.mode() === "control" && (
      state.phase === "unsupported" && !supportedOnce ||
      state.supported && state.phase === "active" && !locallyBlocked && wire?.paused === false
    );
  }

  /** Callers with delayed/coalesced work must supply the epoch captured when
   * that work was queued. It is never replaced with a newer epoch here.
   */
  function prepareInput(message: unknown): unknown | null {
    if (!message || typeof message !== "object") return null;
    const item = message as Record<string, unknown>;
    if (typeof item.kind !== "string") return null;
    let kind = item.kind;
    if (kind === "curtain_off" || kind === "curtain_on") return message;
    if (kind === "release_inputs") {
      if (!state.supported) return message;
      // Legacy release_inputs also clears the curtain. Input cleanup must not.
      kind = "release_keys";
    }
    if (!ordinaryKinds.has(kind) && kind !== "release_keys") return null;
    if (kind !== "release_keys" && !allowed()) return null;
    if (!state.supported) return state.phase === "unsupported" ? message : null;
    if (!wire || !state.epoch) return null;
    const payload = item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
      ? item.payload as Record<string, unknown> : {};
    if (payload.input_epoch !== undefined && payload.input_epoch !== state.epoch) return null;
    return { ...item, kind, payload: { ...payload, input_epoch: state.epoch } };
  }

  function reset(reason = "Agent input state is unknown after disconnect.") {
    locallyBlocked = true;
    pending?.finish(new Error(reason));
    wire = null;
    publish({ ...EMPTY_INPUT_PAUSE, supported: supportedOnce, reason });
  }

  return {
    state: () => state,
    onState(listener: (value: InputPauseState) => void) {
      listeners.add(listener); listener(state);
      return () => { listeners.delete(listener); };
    },
    receive, setPaused, allowed, prepareInput, reset,
    dispose() { reset(); listeners.clear(); },
  };
}
