import {
  startWebRtcLive, type WebRtcLive, type WebRtcOptions, type WebRtcState,
  type FileTransferEvent, type RecordingResult,
} from "./webrtc-live";
import {
  MEDIA_PROFILES, recoveryDelay, recoveryProfileIndex, type MediaFailure, type MediaProgress, type MediaProfile,
} from "./media-profiles";
import type { AgentMode } from "./browser-actions";
import { EMPTY_INPUT_PAUSE, type InputPauseState } from "./browser-input-pause";
import type { CurtainState } from "./browser-curtain";
import { EMPTY_UNLOCK, type UnlockState } from "@/shared/windows-unlock";

export type RecoveryStatus = {
  phase: "connecting" | "live" | "waiting" | "finishing-recording" | "stopped";
  profile: MediaProfile;
  attempt: number;
  retryAt: number | null;
  reason: string | null;
  codec: string | null;
  path: string | null;
};
export interface ResilientWebRtcLive extends WebRtcLive {
  onVideo: (callback: (video: HTMLVideoElement) => void) => () => void;
  onRecovery: (callback: (status: RecoveryStatus) => void) => () => void;
  onInterruptedRecording: (callback: (result: RecordingResult | null) => void) => () => void;
  recovery: () => RecoveryStatus;
  retry: () => void;
}

/** One authorized session, one peer at a time. Never races competing Agent owners. */
export function startResilientWebRtc(
  sessionId: string,
  options: WebRtcOptions = {},
  createPeer: typeof startWebRtcLive = startWebRtcLive,
): ResilientWebRtcLive {
  const idleVideo = document.createElement("video");
  const states = new Set<(value: WebRtcState) => void>();
  const videos = new Set<(value: HTMLVideoElement) => void>();
  const recovery = new Set<(value: RecoveryStatus) => void>();
  const modes = new Set<(value: AgentMode) => void>();
  const inputStates = new Set<(value: InputPauseState) => void>();
  const curtains = new Set<(value: CurtainState) => void>();
  const unlocks = new Set<(value: UnlockState) => void>();
  const files = new Set<(value: FileTransferEvent) => void>();
  const clips = new Set<(value: string) => void>();
  const recordings = new Set<(value: boolean) => void>();
  const segments = new Set<(value: RecordingResult | null) => void>();
  const progress = new Set<(value: MediaProgress) => void>();
  const subscribe = <T,>(set: Set<(value: T) => void>, cb: (value: T) => void) => {
    set.add(cb); return () => { set.delete(cb); };
  };
  const emit = <T,>(set: Set<(value: T) => void>, value: T) => set.forEach(cb => cb(value));
  let peer: WebRtcLive | null = null;
  let currentAgentMode: AgentMode = null;
  let currentInputState: InputPauseState = { ...EMPTY_INPUT_PAUSE };
  let currentUnlock: UnlockState = { ...EMPTY_UNLOCK };
  // Sticky across channel loss/replacement, so a delayed keystroke can never
  // become a legacy REST input after a secure attempt. Explicit control only.
  let sensitiveInput = false;
  let secureRecording = false;
  let detach: (() => void)[] = [];
  let closed = false, paused = false, retiring = false;
  let generation = 0, failures = 0, profileIndex = 0;
  let stable = false, progressSince: number | null = null, lastProgressAt = 0;
  let samePathRetryUsed = false;
  let state: WebRtcState = "connecting";
  let failure: MediaFailure | null = null;
  let timer: number | null = null, deadline: number | null = null, recordingDeadline: number | null = null;
  let status: RecoveryStatus = {
    phase: "connecting", profile: MEDIA_PROFILES[profileIndex], attempt: 0,
    retryAt: null, reason: null, codec: null, path: null,
  };
  const publish = (patch: Partial<RecoveryStatus>) => {
    status = { ...status, ...patch }; emit(recovery, status);
  };
  const setState = (value: WebRtcState) => { state = value; emit(states, value); };
  const clearRetry = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
  const clearDeadline = () => { if (deadline !== null) window.clearTimeout(deadline); deadline = null; };
  const live = (candidate: WebRtcLive, epoch: number) => !closed && peer === candidate && generation === epoch;

  function armDeadline(candidate: WebRtcLive, epoch: number) {
    clearDeadline();
    deadline = window.setTimeout(() => {
      deadline = null;
      if (!live(candidate, epoch) || retiring || paused) return;
      setState("failed");
      void retire(candidate, epoch);
    }, 45_000);
  }

  function schedule(delay: number) {
    clearRetry();
    publish({ phase: "waiting", retryAt: paused ? null : Date.now() + delay });
    if (!paused) timer = window.setTimeout(() => { timer = null; connect(); }, delay);
  }

  async function retire(candidate: WebRtcLive, epoch: number, manual = false) {
    if (!live(candidate, epoch) || retiring) return;
    retiring = true;
    currentInputState = { ...EMPTY_INPUT_PAUSE, supported: currentInputState.supported,
      reason: "The viewer is reconnecting. Resume control explicitly after authorization." };
    emit(inputStates, currentInputState);
    candidate.cancelUnlock?.();
    currentUnlock = { ...EMPTY_UNLOCK };
    emit(unlocks, currentUnlock);
    // Stop privacy/input renewals immediately, not after recording finalization.
    // These act only on the retiring peer, never its replacement.
    candidate.sendInput({ kind: "release_inputs", payload: {} });
    void candidate.setCurtain(false).catch(() => {});
    clearDeadline();
    failure = candidate.failure();
    const terminal = state === "superseded" || failure?.retryable === false;
    const wasStable = stable;
    if (candidate.recording()) {
      publish({ phase: "finishing-recording", retryAt: null });
      let result: RecordingResult | null = null;
      if (!terminal) {
        // Do not silently throw away an authorized recording when replacing a peer.
        result = await Promise.race([
          candidate.stopRecording().catch(() => null),
          new Promise<null>(resolve => {
            recordingDeadline = window.setTimeout(() => resolve(null), 5000);
          }),
        ]);
      }
      if (recordingDeadline !== null) window.clearTimeout(recordingDeadline);
      recordingDeadline = null;
      if (!live(candidate, epoch)) return;
      emit(segments, result);
    }
    // Keep file/error listeners attached through close so partial transfers fail visibly.
    candidate.close();
    detach.forEach(off => off()); detach = [];
    peer = null;
    emit(videos, idleVideo);
    currentAgentMode = null;
    emit(modes, null);
    emit(curtains, { supported: false, active: null, pending: false, reason: "peer_closed" });
    emit(recordings, false);
    retiring = false;
    if (closed) return;
    if (terminal) {
      publish({ phase: "stopped", retryAt: null, reason: state === "superseded" ? "superseded" : failure?.reason ?? "authorization" });
      return;
    }
    failures++;
    // A stream that actually decoded frames gets one same-codec recovery even
    // if it stalled before 30 seconds. Otherwise a short H.264 stall immediately
    // forced VP8 on machines where VP8's native runtime is unavailable.
    const retryWorkingPath = wasStable || (progressSince !== null && !samePathRetryUsed);
    if (!manual && retryWorkingPath) samePathRetryUsed = true;
    else if (!manual) {
      profileIndex = recoveryProfileIndex(profileIndex, failure?.reason ?? "network");
      samePathRetryUsed = false;
    }
    publish({ profile: MEDIA_PROFILES[profileIndex], reason: manual ? "manual" : failure?.reason ?? "network" });
    schedule(manual ? 0 : recoveryDelay(failures, failure?.retryAfterMs));
  }

  function connect() {
    if (closed || paused || retiring) return;
    const epoch = ++generation;
    stable = false; progressSince = null; lastProgressAt = 0; failure = null;
    setState("connecting");
    publish({
      phase: "connecting", profile: MEDIA_PROFILES[profileIndex], attempt: status.attempt + 1,
      retryAt: null, reason: null, codec: null, path: null,
    });
    let candidate: WebRtcLive;
    try {
      candidate = createPeer(sessionId, {
        ...options, strictPeerIdentity: options.strictPeerIdentity ?? true,
        profile: MEDIA_PROFILES[profileIndex],
      });
    } catch {
      failure = { reason: "network", retryable: true };
      failures++;
      profileIndex = recoveryProfileIndex(profileIndex, "network");
      setState("failed");
      publish({ profile: MEDIA_PROFILES[profileIndex], reason: failure.reason });
      schedule(recoveryDelay(failures));
      return;
    }
    peer = candidate;
    emit(videos, candidate.video);
    candidate.setPaused(paused);
    candidate.onState(value => {
      if (!live(candidate, epoch) || retiring) return;
      setState(value);
      if (value === "failed" || value === "superseded") void retire(candidate, epoch);
    });
    const forward = <T,>(set: Set<(value: T) => void>) => (value: T) => {
      if (live(candidate, epoch)) emit(set, value);
    };
    detach = [
      candidate.onUnlock?.(value => {
        if (!live(candidate, epoch) || retiring) return;
        currentUnlock = value;
        if (["starting", "ready", "submitted"].includes(value.phase)) {
          sensitiveInput = true; secureRecording = true;
        }
        emit(unlocks, value);
      }) ?? (() => {}),
      candidate.onAgentMode(value => {
        if (!live(candidate, epoch) || retiring) return;
        currentAgentMode = value;
        emit(modes, value);
      }), candidate.onInputPause(value => {
        if (!live(candidate, epoch) || retiring) return;
        currentInputState = value;
        emit(inputStates, value);
      }), candidate.onCurtain(forward(curtains)),
      candidate.onFile(forward(files)), candidate.onClipboard(forward(clips)),
      candidate.onRecording(forward(recordings)),
      candidate.onMedia(value => {
        if (!live(candidate, epoch) || retiring || paused) return;
        clearDeadline();
        const now = Date.now();
        if (progressSince === null || now - lastProgressAt > 6000) progressSince = now;
        lastProgressAt = now;
        if (now - progressSince >= 30_000) { stable = true; failures = 0; samePathRetryUsed = false; }
        publish({ phase: "live", reason: null, codec: value.codec, path: value.path });
        emit(progress, value);
      }),
    ];
    // Bounds hung binding, SDP, and first-frame work, including APIs ignoring abort.
    armDeadline(candidate, epoch);
    if (candidate.state() === "failed" || candidate.state() === "superseded") {
      setState(candidate.state()); void retire(candidate, epoch);
    }
  }

  connect();
  return {
    sessionId,
    get video() { return peer?.video ?? idleVideo; },
    state: () => state, onState: cb => subscribe(states, cb),
    failure: () => failure ?? peer?.failure() ?? null,
    candidateType: () => peer?.candidateType() ?? null,
    codec: () => peer?.codec() ?? null,
    stats: () => peer?.stats() ?? Promise.resolve(null),
    diagnostics: () => peer?.diagnostics?.() ?? null,
    relay: () => peer?.relay() ?? "pending",
    onMedia: cb => subscribe(progress, cb),
    onVideo: cb => subscribe(videos, cb),
    onRecovery: cb => subscribe(recovery, cb),
    onInterruptedRecording: cb => subscribe(segments, cb),
    recovery: () => status,
    retry: () => {
      if (closed || retiring || status.phase === "stopped") return;
      if (peer) { setState("failed"); void retire(peer, generation, true); }
      else { clearRetry(); failures = 0; connect(); }
    },
    setPaused: value => {
      // React may report the same value when the video element changes.
      // Only an actual resume may bypass the retry delay.
      if (paused === value) return;
      paused = value; peer?.setPaused(value);
      if (paused) { clearRetry(); clearDeadline(); publish({ retryAt: null }); }
      else if (!peer && status.phase === "waiting") schedule(0);
      else if (peer && status.phase !== "live") armDeadline(peer, generation);
    },
    sendInput: payload => !sensitiveInput && !retiring && !!peer?.sendInput(payload),
    inputPause: () => currentInputState,
    onInputPause: cb => { const off = subscribe(inputStates, cb); cb(currentInputState); return off; },
    inputAllowed: () => !sensitiveInput && !retiring && !!peer?.inputAllowed(),
    setInputPaused: (value, signal) => !retiring && peer
      ? peer.setInputPaused(value, signal) : Promise.reject(new Error("The input channel is reconnecting.")),
    sensitiveInput: () => sensitiveInput,
    prepareUnlock: () => {
      sensitiveInput = true; secureRecording = true;
      if (retiring || !peer) throw new Error("The unlock channel is unavailable.");
      peer.prepareUnlock();
    },
    resumeOrdinaryInput: () => {
      if (!retiring && !["starting", "ready", "submitted"].includes(currentUnlock.phase) && currentAgentMode === "control")
      { sensitiveInput = false; peer?.resumeOrdinaryInput(); }
    },
    peerId: () => !retiring ? peer?.peerId?.() ?? null : null,
    unlockState: () => ({ ...currentUnlock }),
    onUnlock: cb => { const off = subscribe(unlocks, cb); cb({ ...currentUnlock }); return off; },
    beginUnlock: ticket => !retiring && peer ? peer.beginUnlock(ticket) : Promise.reject(new Error("Viewer is reconnecting.")),
    cancelUnlock: () => peer?.cancelUnlock?.(),
    useSavedUnlockPin: () => {
      if (retiring || !peer) throw new Error("Unlock channel unavailable.");
      peer.useSavedUnlockPin();
    },
    sendUnlockInput: (kind, payload) => !retiring && !!peer?.sendUnlockInput(kind, payload),
    sendUnlockSas: () => !retiring && !!peer?.sendUnlockSas(),
    onAgentMode: cb => {
      const off = subscribe(modes, cb);
      cb(currentAgentMode);
      return off;
    },
    selectMonitor: name => peer?.selectMonitor(name) ?? Promise.reject(new Error("Video is reconnecting.")),
    refreshAgentMode: (mode, signal) => !retiring && peer
      ? peer.refreshAgentMode(mode, signal) : Promise.reject(new Error("Video is reconnecting.")),
    onCurtain: cb => subscribe(curtains, cb),
    setCurtain: enabled => peer?.setCurtain(enabled) ?? Promise.reject(new Error("Video is reconnecting.")),
    filesReady: () => !retiring && !!peer?.filesReady(),
    sendFile: file => !retiring && peer ? peer.sendFile(file) : Promise.resolve(false),
    onFile: cb => subscribe(files, cb),
    clipboardReady: () => !retiring && !!peer?.clipboardReady(),
    sendClipboard: text => !retiring && !!peer?.sendClipboard(text),
    onClipboard: cb => subscribe(clips, cb),
    canRecord: () => !secureRecording && !retiring && !!peer?.canRecord(),
    recording: () => !!peer?.recording(),
    recordingIssue: () => peer?.recordingIssue?.() ?? null,
    startRecording: () => !secureRecording && !retiring && peer ? peer.startRecording() : Promise.resolve(false),
    onRecording: cb => subscribe(recordings, cb),
    stopRecording: () => peer?.stopRecording() ?? Promise.resolve(null),
    close: () => {
      if (closed) return;
      closed = true; generation++;
      clearRetry(); clearDeadline();
      // Let the bounded finalizer resolve, but its epoch guard prevents later delivery/retry.
      peer?.close(); peer = null;
      detach.forEach(off => off()); detach = [];
      states.clear(); videos.clear(); recovery.clear(); modes.clear(); inputStates.clear(); curtains.clear(); unlocks.clear();
      files.clear(); clips.clear(); recordings.clear(); segments.clear(); progress.clear();
    },
  };
}
