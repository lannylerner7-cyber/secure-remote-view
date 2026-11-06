import {
  startWebRtcLive, type WebRtcLive, type WebRtcOptions, type WebRtcState,
  type FileTransferEvent, type RecordingResult,
} from "./webrtc-live";
import {
  MEDIA_PROFILES, recoveryDelay, type MediaFailure, type MediaProgress, type MediaProfile,
} from "./media-profiles";
import type { AgentMode } from "./browser-actions";
import type { CurtainState } from "./browser-curtain";

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
  const curtains = new Set<(value: CurtainState) => void>();
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
  let detach: (() => void)[] = [];
  let closed = false, paused = false, retiring = false;
  let generation = 0, failures = 0, profileIndex = 0;
  let stable = false, progressSince: number | null = null, lastProgressAt = 0;
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
    // A path that delivered 30 seconds of fresh video earns one same-path retry.
    // Otherwise advance codec/route; never interrupt a healthy peer to "upgrade".
    if (!manual && !wasStable) profileIndex = (profileIndex + 1) % MEDIA_PROFILES.length;
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
      profileIndex = (profileIndex + 1) % MEDIA_PROFILES.length;
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
      candidate.onAgentMode(forward(modes)), candidate.onCurtain(forward(curtains)),
      candidate.onFile(forward(files)), candidate.onClipboard(forward(clips)),
      candidate.onRecording(forward(recordings)),
      candidate.onMedia(value => {
        if (!live(candidate, epoch) || retiring || paused) return;
        clearDeadline();
        const now = Date.now();
        if (progressSince === null || now - lastProgressAt > 6000) progressSince = now;
        lastProgressAt = now;
        if (now - progressSince >= 30_000) { stable = true; failures = 0; }
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
    state: () => state, onState: cb => { states.add(cb); },
    failure: () => failure ?? peer?.failure() ?? null,
    candidateType: () => peer?.candidateType() ?? null,
    codec: () => peer?.codec() ?? null,
    stats: () => peer?.stats() ?? Promise.resolve(null),
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
    sendInput: payload => !retiring && !!peer?.sendInput(payload),
    onAgentMode: cb => subscribe(modes, cb),
    selectMonitor: name => peer?.selectMonitor(name) ?? Promise.reject(new Error("Video is reconnecting.")),
    onCurtain: cb => subscribe(curtains, cb),
    setCurtain: enabled => peer?.setCurtain(enabled) ?? Promise.reject(new Error("Video is reconnecting.")),
    filesReady: () => !retiring && !!peer?.filesReady(),
    sendFile: file => !retiring && peer ? peer.sendFile(file) : Promise.resolve(false),
    onFile: cb => subscribe(files, cb),
    clipboardReady: () => !retiring && !!peer?.clipboardReady(),
    sendClipboard: text => !retiring && !!peer?.sendClipboard(text),
    onClipboard: cb => subscribe(clips, cb),
    canRecord: () => !retiring && !!peer?.canRecord(),
    recording: () => !!peer?.recording(),
    startRecording: () => !retiring && peer ? peer.startRecording() : Promise.resolve(false),
    onRecording: cb => subscribe(recordings, cb),
    stopRecording: () => peer?.stopRecording() ?? Promise.resolve(null),
    close: () => {
      if (closed) return;
      closed = true; generation++;
      clearRetry(); clearDeadline();
      // Let the bounded finalizer resolve, but its epoch guard prevents later delivery/retry.
      peer?.close(); peer = null;
      detach.forEach(off => off()); detach = [];
      states.clear(); videos.clear(); recovery.clear(); modes.clear(); curtains.clear();
      files.clear(); clips.clear(); recordings.clear(); segments.clear(); progress.clear();
    },
  };
}
