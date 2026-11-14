// PLAYWRIGHT ONLY. Fulfill the webrtc-live.ts module request with this source.
// Uses the REAL browser action/pause state machines. Only transport and host
// effects are simulated. Never import this module into the application.
import { createBrowserActions } from "./browser-actions.ts";
import { bindAdmin } from "./webrtc-signal.functions.ts";
import { getWebClientId } from "../shared/signaling-identity.ts";

export function startWebRtcLive(sessionId, options) {
  if (sessionId !== window.__sessionToolsFixtureSessionId)
    throw Error("The test peer refuses a non-synthetic session.");
  const test = window.__sessionToolsFixture ??= { peerCount: 0, acceptedInputs: 0, sent: [], pauseDelay: 0 };
  test.peerCount++;
  const peerId = crypto.randomUUID(), processId = crypto.randomUUID(), controllerId = getWebClientId();
  let closed = false, connected = false, mode = "view", curtain = false;
  let paused = true, epoch = crypto.randomUUID(), revision = 0, frames = 0, playbackPaused = false;
  let recorder = null, recordingStarted = 0, chunks = [];
  const listeners = new Map();
  const emit = (name, value) => { for (const cb of listeners.get(name) ?? []) cb(value); };
  const on = (name, cb) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return () => listeners.get(name)?.delete(cb);
  };
  const state = () => closed ? "failed" : connected ? "connected" : "connecting";
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const context = canvas.getContext("2d"), stream = canvas.captureStream(15);
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  void video.play();
  const frame = (extra = {}) => ({
    kind: "permission_status", session_id: sessionId, authorization_id: options.authorizationId,
    mode, permission_refresh_supported: true, curtain_supported: true, curtain_active: curtain,
    peer_id: peerId, controller_id: controllerId, process_id: processId,
    input_pause_supported: true, input_pause_protocol: 1,
    input_paused: paused, input_epoch: epoch, input_revision: revision, input_release_confirmed: true, ...extra,
  });
  let actions;
  const receipt = value => { if (!closed) actions.receive(JSON.stringify(value)); };
  const channel = {
    readyState: "open", bufferedAmount: 0,
    send(raw) {
      const { kind, payload = {} } = JSON.parse(raw);
      test.sent.push({ kind }); // Never record typed text, credentials, or tokens.
      if (kind === "permission_refresh") {
        mode = payload.mode;
        if (mode === "view") { paused = true; revision++; epoch = crypto.randomUUID(); }
        queueMicrotask(() => receipt(frame({ request_id: payload.request_id, status: "applied" })));
      } else if (["curtain_on", "curtain_off", "curtain_renew"].includes(kind)) {
        if (kind !== "curtain_renew") curtain = kind === "curtain_on" && mode === "control";
        queueMicrotask(() => receipt(frame({ kind: "action_status", action: kind,
          request_id: payload.request_id, status: "applied", active: curtain })));
      } else if (kind === "input_pause") {
        const valid = payload.input_epoch === epoch && payload.input_revision === revision;
        if (valid) { paused = payload.paused; revision++; epoch = crypto.randomUUID(); }
        const answer = frame({ kind: "input_pause_status", action: kind, request_id: payload.request_id,
          status: valid ? "applied" : "rejected" });
        const delay = test.pauseDelay; test.pauseDelay = 0;
        setTimeout(() => receipt(answer), delay);
        test.lastReceipt = answer;
      } else if (["mousemove", "mousemove_rel", "mousedown", "mouseup", "wheel",
        "keydown", "keyup", "key_sequence", "unicode_text", "text"].includes(kind)) {
        if (!paused && payload.input_epoch === epoch && mode === "control") test.acceptedInputs++;
      }
    },
  };
  const close = () => {
    if (closed) return;
    closed = true; paused = true; curtain = false;
    clearInterval(tick);
    actions.dispose();
    if (recorder?.state === "recording") recorder.stop();
    stream.getTracks().forEach(track => track.stop());
  };
  actions = createBrowserActions(sessionId, options.authorizationId, () => channel,
    () => !closed, () => { close(); emit("State", "failed"); }, { peerId, controllerId });
  const tick = setInterval(() => {
    frames++;
    context.fillStyle = "#12233b"; context.fillRect(0, 0, 1280, 720);
    context.fillStyle = "#e2e8f0"; context.font = "32px sans-serif";
    context.fillText("SIMULATED SESSION — NO WINDOWS HOST", 70, 100);
    context.font = "26px monospace";
    context.fillText(`Advancing frame ${frames} · Input ${paused ? "PAUSED" : "ACTIVE"}`, 70, 170);
    context.fillStyle = "#4f7cff"; context.fillRect((frames * 11) % 1100, 300, 120, 120);
    if (connected && !playbackPaused) emit("Media", { framesDecoded: frames, codec: null, path: "fixture" });
  }, 100);
  void bindAdmin({ data: { sessionId, clientId: controllerId } }).then(result => {
    if (closed) return;
    if (!result.bound) { close(); emit("State", "failed"); return; }
    connected = true; receipt(frame()); emit("State", "connected");
  }).catch(() => { close(); emit("State", "failed"); });
  test.snapshot = () => ({ peerId, paused, epoch, revision, curtain, frames,
    recording: recorder?.state === "recording", closed });
  test.replayLastReceipt = () => receipt(test.lastReceipt);
  test.disconnect = () => { close(); emit("State", "failed"); };
  test.startIncoming = (name = "synthetic-transfer.txt") => {
    emit("File", { kind: "begin", name, size: 1024 });
    emit("File", { kind: "progress", name, size: 1024, sent: 512 });
  };
  test.finishIncoming = (name = "synthetic-transfer.txt") =>
    emit("File", { kind: "error", name, message: "Synthetic transfer ended; no remote file was stored." });
  const stopRecording = async () => {
    if (!recorder || recorder.state !== "recording") return null;
    const active = recorder;
    await new Promise(resolve => { active.addEventListener("stop", resolve, { once: true }); active.stop(); });
    const blob = new Blob(chunks, { type: active.mimeType });
    recorder = null; emit("Recording", false);
    return { blob, mimeType: active.mimeType, durationMs: performance.now() - recordingStarted };
  };
  return {
    sessionId, video, state, close,
    onState: cb => { cb(state()); return on("State", cb); },
    onMedia: cb => on("Media", cb), onFile: cb => on("File", cb),
    onClipboard: cb => on("Clipboard", cb), onRecording: cb => on("Recording", cb),
    onAgentMode: actions.onMode, refreshAgentMode: actions.refreshMode,
    onCurtain: actions.onCurtain, setCurtain: actions.setCurtain,
    inputPause: actions.inputPause.state, onInputPause: actions.inputPause.onState,
    inputAllowed: actions.inputPause.allowed, setInputPaused: actions.inputPause.setPaused,
    sendInput: actions.sendInput,
    peerId: () => peerId, setPaused: value => { playbackPaused = value; },
    sensitiveInput: () => false, resumeOrdinaryInput() {}, prepareUnlock() {},
    unlockState: () => ({ phase: "idle", requestId: null, reason: null }),
    onUnlock: cb => { cb({ phase: "idle", requestId: null, reason: null }); return () => {}; },
    beginUnlock: async () => { throw Error("Real Windows sign-in is unavailable in this simulation."); },
    cancelUnlock() {}, useSavedUnlockPin() {}, sendUnlockInput: () => false, sendUnlockSas: () => false,
    filesReady: () => connected && !closed, clipboardReady: () => connected && !closed,
    sendFile: async file => { emit("File", { kind: "progress", name: file.name, size: file.size, sent: 0 });
      await new Promise(resolve => setTimeout(resolve, 1500));
      emit("File", { kind: "sent", name: file.name, size: file.size }); return true; },
    sendClipboard: () => true, selectMonitor: async () => {},
    failure: () => closed ? { reason: "network", retryable: true } : null,
    candidateType: () => null, codec: () => null, stats: async () => new Map(),
    diagnostics: () => null, relay: () => "relay",
    canRecord: () => connected && !closed, recording: () => recorder?.state === "recording",
    recordingIssue: () => null,
    startRecording: async () => {
      if (recorder) return false;
      chunks = []; recordingStarted = performance.now();
      recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      recorder.addEventListener("dataavailable", e => { if (e.data.size) chunks.push(e.data); });
      recorder.start(100); emit("Recording", true); return true;
    },
    stopRecording,
  };
}
