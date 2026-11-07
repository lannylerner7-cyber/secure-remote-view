import type { AgentMode } from "./browser-actions";
import type { WebRtcState } from "./webrtc-live";

export type ControlStage =
  | "idle" | "requesting-control" | "waiting-agent" | "applying-curtain"
  | "active" | "releasing" | "error";

export interface ControlPeer {
  state(): WebRtcState;
  onAgentMode(listener: (mode: AgentMode) => void): () => void;
  onState(listener: (state: WebRtcState) => void): () => void;
  setCurtain(enabled: boolean): Promise<void>;
  sendInput(message: { kind: string; payload: Record<string, unknown> }): boolean;
}

interface ControlOptions {
  peer: ControlPeer;
  /** Windows uses a curtain; Android retains its existing control-only flow. */
  withCurtain?: boolean;
  initialMode: AgentMode;
  signal: AbortSignal;
  /** False after a peer replacement, session/grant change or permission loss. */
  isCurrent(): boolean;
  /** Checks peer identity without requiring control permission (for cleanup). */
  isSamePeer(): boolean;
  setMode(mode: "view" | "control", signal: AbortSignal): Promise<void>;
  onStage(stage: ControlStage): void;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Control request cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Release is available even when the command channel or control grant is gone. */
export async function releaseControlAndCurtain(
  options: Pick<ControlOptions, "isSamePeer" | "setMode" | "onStage" | "withCurtain"> & { peer: ControlPeer | null },
): Promise<{ curtainConfirmed: boolean }> {
  options.onStage("releasing");
  let curtain: Promise<boolean> = Promise.resolve(false);
  if (options.peer && options.isSamePeer()) {
    options.peer.sendInput({ kind: "release_inputs", payload: {} });
    if (options.withCurtain !== false)
      curtain = options.peer.setCurtain(false).then(() => true, () => false);
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(
    "The server did not confirm view mode. Release remains unconfirmed.",
  )), 8000);
  try {
    await abortable(options.setMode("view", deadline.signal), deadline.signal);
    // The curtain protocol itself has a three-second receipt deadline.
    const curtainConfirmed = await abortable(curtain, deadline.signal);
    return { curtainConfirmed };
  } finally { clearTimeout(timer); }
}

/** One explicit action: server permission -> Agent acknowledgement -> curtain. */
export async function takeControlAndCurtain(options: ControlOptions): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason ?? new Error("Control request cancelled."));
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const deadline = setTimeout(() => controller.abort(new Error(
    "The Agent did not confirm control and curtain in time. No control was enabled.",
  )), 15000);
  let requested = false;
  let offMode = () => {}, offState = () => {};
  const assertCurrent = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!options.isCurrent() || options.peer.state() !== "connected")
      throw new Error("The Agent command channel or authorization changed. Control was not enabled.");
  };
  try {
    assertCurrent();
    if (!options.initialMode) throw new Error("The Agent has not acknowledged its command channel.");
    const acknowledged = new Promise<void>(resolve => {
      let confirmed = options.initialMode === "control";
      if (confirmed) resolve();
      offMode = options.peer.onAgentMode(mode => {
        if (mode === null) controller.abort(new Error("The Agent command channel disconnected."));
        else if (mode === "control") { confirmed = true; resolve(); }
        else if (confirmed) controller.abort(new Error("The Agent withdrew control permission."));
      });
    });
    offState = options.peer.onState(state => {
      if (state !== "connected") controller.abort(new Error("The Agent connection changed."));
    });
    assertCurrent();
    options.onStage("requesting-control");
    requested = true;
    await abortable(options.setMode("control", controller.signal), controller.signal);
    assertCurrent();
    options.onStage("waiting-agent");
    await abortable(acknowledged, controller.signal);
    assertCurrent();
    if (options.withCurtain !== false) {
      options.onStage("applying-curtain");
      await abortable(options.peer.setCurtain(true), controller.signal);
      assertCurrent();
    }
    options.onStage("active");
  } catch (error) {
    // Never act through a replacement peer; never undo a new viewer's takeover.
    if (requested && options.peer.state() !== "superseded") {
      try { await releaseControlAndCurtain(options); }
      catch {
        options.onStage("error");
        throw new Error(`${error instanceof Error ? error.message : "Control failed"} View-mode rollback was not confirmed. Use Release control.`);
      }
    }
    options.onStage("error");
    throw error;
  } finally {
    offMode(); offState();
    clearTimeout(deadline);
    options.signal.removeEventListener("abort", cancel);
  }
}
