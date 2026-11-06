const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const assert = require("node:assert/strict");
let now = 100, permitted = false, constructed = 0, stopped = 0, id = 0;
let deferStop = false, finishStop;
const timers = new Map();
const timer = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
const channel = { on() { return this; }, subscribe() { return this; } };
class Stream { getVideoTracks() { return [{}]; } }
class Recorder {
  static isTypeSupported() { return true; }
  constructor() { constructed++; this.mimeType = "video/webm"; }
  start() {}
  stop() {
    stopped++;
    const finish = () => {
      this.ondataavailable?.({ data: new Blob(["test frame"]) });
      this.onstop?.();
    };
    if (deferStop) finishStop = finish; else finish();
  }
}
class Peer {
  createDataChannel() { return { readyState: "open", send() {}, close() {} }; }
  setConfiguration() {}
  addTransceiver() {}
  createOffer() { return Promise.resolve({ type: "offer", sdp: "" }); }
  setLocalDescription() { return Promise.resolve(); }
  close() {}
}
const dependencies = {};
const common = {
  console: { ...console, info() {}, debug() {} }, Blob, AbortController,
  performance: { now: () => now },
  window: { setTimeout: timer, setInterval: timer,
    clearTimeout: i => timers.delete(i), clearInterval: i => timers.delete(i) },
  document: { createElement: () => ({ style: {}, srcObject: null, play: async () => {} }) },
  localStorage: storage, sessionStorage: storage, crypto: require("node:crypto").webcrypto,
  RTCPeerConnection: Peer, MediaStream: Stream, MediaRecorder: Recorder,
  fetch: async url => ({ ok: true, json: async () => String(url).endsWith("/authorization")
    ? { allowed: true, capabilities: { recording: permitted },
        authorizationId: "12345678-1234-1234-1234-123456789012" }
    : { iceServers: [] } }),
};
function load(path) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { ...common, exports, require: name => {
    if (!(name in dependencies)) {
      const file = name.startsWith("@/") ? `src/${name.slice(2)}.ts`
        : `src/lib/${name.slice(2)}.ts`;
      if (!fs.existsSync(file)) throw Error(`Unmocked import ${name}`);
      dependencies[name] = load(file);
    }
    return dependencies[name];
  } });
  return exports;
}
dependencies["@/lib/recording-authority"] = load("src/lib/recording-authority.ts");
dependencies["@/integrations/supabase/client"] = { supabase: {
  auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-test-only" } } }) },
  channel: () => channel, removeChannel() {},
} };
dependencies["@/lib/webrtc-signal.functions"] = {
  postAdminSignal: async () => ({ ok: true }), bindAdmin: async () => ({ bound: true }),
};
dependencies["@/shared/api-routes"] = { API_ROUTES: {
  agentIce: "/ice", adminSessionAuthorization: id => `/session/${id}/authorization`,
} };
(async () => {
  const { startWebRtcLive } = load("src/lib/webrtc-live.ts");
  const live = startWebRtcLive("test-session");
  live.video.srcObject = new Stream();
  assert.equal(await live.startRecording(), false);
  assert.equal(constructed, 0, "view-only grant must not construct MediaRecorder");
  assert.equal(await live.stopRecording(), null);
  permitted = true;
  assert.equal(await live.startRecording(), true);
  assert.equal(live.recording(), true);
  permitted = false;
  for (const t of [...timers.values()]) if (t.ms === 2000) await t.fn();
  assert.equal(live.recording(), false, "revocation stops the actual recorder");
  assert.equal(stopped, 1);
  assert.equal(await live.stopRecording(), null, "revoked chunks cannot be saved");
  permitted = true;
  assert.equal(await live.startRecording(), true);
  now += 5000;
  for (const t of [...timers.values()]) if (t.ms === 100) t.fn();
  assert.equal(live.recording(), false);
  assert.equal(await live.stopRecording(), null, "expired chunks cannot be saved");
  assert.equal(await live.startRecording(), true);
  const saved = await live.stopRecording();
  assert.ok(saved?.blob.size > 0, "authorized recording still saves");
  assert.equal(await live.startRecording(), true);
  deferStop = true;
  const manualStop = live.stopRecording();
  for (let n = 0; n < 16; n++) await Promise.resolve();
  assert.equal(typeof finishStop, "function");
  assert.equal(live.recording(), true, "pending final data must retain peer ownership");
  const recoveryStop = live.stopRecording();
  assert.equal(manualStop, recoveryStop, "manual stop and recovery must join one finalizer");
  finishStop();
  const [manualResult, recoveryResult] = await Promise.all([manualStop, recoveryStop]);
  assert.equal(manualResult.blob, recoveryResult.blob, "deliver one shared recording segment");
  assert.equal(live.recording(), false);
  live.close();
  console.log("19 recording assertions passed with mocked browser/transport APIs.");
})().catch(e => { console.error(e); process.exitCode = 1; });
