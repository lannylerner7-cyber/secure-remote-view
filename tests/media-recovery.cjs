// Deterministic peer/timer tests. No device, database, credential or network access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");

const compile = name => ts.transpileModule(
  fs.readFileSync(`src/lib/${name}.ts`, "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const profiles = {};
vm.runInNewContext(compile("media-profiles"), { exports: profiles });
const unlock = {};
vm.runInNewContext(compile("../shared/windows-unlock"), { exports: unlock });
const inputPause = {};
vm.runInNewContext(compile("browser-input-pause"), { exports: inputPause });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(options = {}) {
  let now = 100_000, nextTimer = 0, active = 0, peak = 0;
  const timers = new Map(), peers = [], calls = [];
  const window = {
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const exports = {};
  vm.runInNewContext(compile("resilient-webrtc"), {
    exports, window, document: { createElement: () => ({ idle: true }) },
    Date: class extends Date { static now() { return now; } },
    require(name) {
      if (name === "./media-profiles") return profiles;
      if (name === "./webrtc-live") return {};
      if (name === "@/shared/windows-unlock") return unlock;
      if (name === "./browser-input-pause") return inputPause;
      throw Error(`Unexpected import: ${name}`);
    },
  });
  function createPeer(sessionId, config) {
    calls.push({ sessionId, config });
    active++; peak = Math.max(active, peak);
    const events = Object.fromEntries(["State", "Media", "AgentMode", "InputPause", "Curtain", "File", "Clipboard", "Recording"]
      .map(name => [name, new Set()]));
    const emit = (name, value) => events[name].forEach(fn => fn(value));
    const peer = {
      video: { id: peers.length }, closed: false, paused: false, isRecording: false,
      currentState: "connecting", currentFailure: null, stopCalls: 0, pendingFile: false,
      state() { return this.currentState; }, failure() { return this.currentFailure; },
      setPaused(value) { this.paused = value; },
      inputPause: () => ({ ...inputPause.EMPTY_INPUT_PAUSE }),
      inputAllowed: () => false,
      setInputPaused: async () => { throw Error("Not authorized by this media-only fixture"); },
      recording() { return this.isRecording; },
      stopRecording() { this.stopCalls++; this.isRecording = false; return Promise.resolve(this.result ?? null); },
      close() {
        if (this.closed) return;
        this.closed = true; active--; this.isRecording = false;
        if (this.pendingFile) emit("File", { kind: "error", name: "partial.bin", message: "interrupted" });
      },
      fail(reason = "network", retryable = true, retryAfterMs) {
        this.currentFailure = { reason, retryable, retryAfterMs };
        this.currentState = "failed"; emit("State", "failed");
      },
      supersede() { this.currentState = "superseded"; emit("State", "superseded"); },
      progress(frames = 1) { emit("Media", { framesDecoded: frames, codec: "H264", path: "relay" }); },
      filesReady: () => true, clipboardReady: () => true,
      sendInput: () => true, sendFile: async () => true, sendClipboard: () => true,
      canRecord: () => true, startRecording: async () => true,
      selectMonitor: async () => {}, setCurtain: async () => {},
      relay: () => "relay", codec: () => "H264", candidateType: () => "relay",
      stats: async () => null,
    };
    for (const [name, callbacks] of Object.entries(events))
      peer[`on${name}`] = cb => { callbacks.add(cb); return () => callbacks.delete(cb); };
    peers.push(peer);
    return peer;
  }
  const live = exports.startResilientWebRtc("authorized-session", {
    authorizationId: "unchanged-grant", ...options,
  }, createPeer);
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry;
      now = timer.at; timers.delete(id); timer.fn(); await flush();
    }
    now = end; await flush();
  }
  return { live, peers, calls, advance, timers, get peak() { return peak; }, get active() { return active; } };
}

test("state subscriptions provide working cleanup for control transactions", () => {
  const f = fixture(), seen = [];
  const off = f.live.onState(value => seen.push(value));
  assert.equal(typeof off, "function");
  off();
  f.peers[0].fail();
  assert.deepEqual(seen, []);
  f.live.close();
});

test("codec/route sequence uses one peer and the same authorization/session", async () => {
  const f = fixture();
  assert.equal(f.calls[0].config.profile.codec, "h264-preferred");
  for (const [index, delay] of [1000, 2000, 4000, 30000].entries()) {
    f.peers[index].fail("media");
    assert.equal(f.peers[index].closed, true);
    await f.advance(delay - 1);
    assert.equal(f.peers.length, index + 1);
    await f.advance(1);
    assert.equal(f.peers.length, index + 2);
  }
  assert.deepEqual(f.calls.map(c => [c.config.profile.codec, c.config.profile.route]), [
    ["h264-preferred", "all"], ["vp8", "all"],
    ["h264-preferred", "relay"], ["vp8", "relay"], ["h264-preferred", "all"],
  ]);
  assert.equal(f.peak, 1);
  assert.ok(f.calls.every(c => c.sessionId === "authorized-session" &&
    c.config.authorizationId === "unchanged-grant" && c.config.strictPeerIdentity));
  f.live.close();
});

test("video-only recovery never changes its transport permission", async () => {
  const f = fixture({ videoOnly: true });
  f.peers[0].fail(); await f.advance(1000);
  assert.ok(f.calls.every(c => c.config.videoOnly === true));
  f.live.close();
});

test("short working H264 stream gets one same-codec recovery before changing profiles", async () => {
  const f = fixture({ videoOnly: true });
  f.peers[0].progress(103);
  await f.advance(12_000);
  f.peers[0].fail("media");
  await f.advance(1000);
  assert.equal(f.calls[1].config.profile.codec, "h264-preferred");
  f.peers[1].progress(10);
  f.peers[1].fail("media");
  await f.advance(2000);
  assert.equal(f.calls[2].config.profile.codec, "vp8", "repeated short failures must not loop at full speed");
  assert.equal(f.peak, 1);
  assert.ok(f.calls.every(c => c.config.videoOnly && c.config.authorizationId === "unchanged-grant"));
  f.live.close();
});

test("fresh video stays on its healthy path and earns one same-profile retry", async () => {
  const f = fixture();
  for (let n = 1; n <= 18; n++) { f.peers[0].progress(n); await f.advance(2000); }
  assert.equal(f.peers.length, 1);
  assert.equal(f.live.recovery().phase, "live");
  assert.equal(f.live.recovery().codec, "H264");
  f.peers[0].fail(); await f.advance(1000);
  assert.equal(f.calls[1].config.profile.codec, "h264-preferred");
  f.peers[1].fail(); await f.advance(2000);
  assert.equal(f.calls[2].config.profile.codec, "h264-preferred");
  assert.equal(f.calls[2].config.profile.route, "relay");
  f.live.close();
});

test("network and signaling failure alternate routes without forcing an unavailable VP8 codec", async () => {
  const f = fixture();
  f.peers[0].fail("network"); await f.advance(1000);
  assert.equal(f.calls[1].config.profile.codec, "h264-preferred");
  assert.equal(f.calls[1].config.profile.route, "relay");
  f.peers[1].fail("signaling"); await f.advance(2000);
  assert.equal(f.calls[2].config.profile.codec, "h264-preferred");
  assert.equal(f.calls[2].config.profile.route, "all");
  f.peers[2].fail("unsupported-codec"); await f.advance(4000);
  assert.equal(f.calls[3].config.profile.codec, "vp8");
  f.live.close();
});

test("permission denial and supersession stop automatic and manual retries", async () => {
  for (const superseded of [false, true]) {
    const f = fixture();
    if (superseded) f.peers[0].supersede(); else f.peers[0].fail("authorization", false);
    assert.equal(f.live.recovery().phase, "stopped");
    f.live.retry(); await f.advance(600_000);
    assert.equal(f.peers.length, 1); assert.equal(f.active, 0);
    f.live.close();
  }
});

test("pause defers recovery and a resumed startup still has a deadline", async () => {
  const f = fixture();
  f.live.setPaused(true); await f.advance(60_000);
  assert.equal(f.peers.length, 1);
  f.live.setPaused(false); await f.advance(45_000);
  assert.equal(f.live.recovery().phase, "waiting");
  f.live.setPaused(true); await f.advance(60_000);
  assert.equal(f.peers.length, 1);
  f.live.setPaused(false); await f.advance(0);
  assert.equal(f.peers.length, 2);
  f.live.close();
});

test("unchanged playback state cannot bypass backoff on video replacement", async () => {
  const f = fixture();
  f.peers[0].fail();
  f.live.setPaused(false);
  f.live.setPaused(false);
  await f.advance(999);
  assert.equal(f.peers.length, 1);
  await f.advance(1);
  assert.equal(f.peers.length, 2);
  f.live.close();
});

test("late callbacks and close cannot resurrect an old peer", async () => {
  const f = fixture(), videos = [];
  f.live.onVideo(video => videos.push(video));
  f.peers[0].fail(); await f.advance(1000);
  f.peers[0].progress(99); f.peers[0].fail();
  assert.equal(f.live.recovery().phase, "connecting");
  assert.equal(videos.at(-1), f.peers[1].video);
  f.peers[1].fail(); f.live.close(); await f.advance(600_000);
  assert.equal(f.peers.length, 2); assert.equal(f.active, 0); assert.equal(f.timers.size, 0);
});

test("recording is finalized before replacement and partial files fail visibly", async () => {
  const f = fixture(), segments = [], files = [];
  const peer = f.peers[0];
  peer.isRecording = true;
  peer.pendingFile = true;
  peer.result = { blob: { size: 123 }, durationMs: 1000, mimeType: "video/webm" };
  f.live.onInterruptedRecording(value => segments.push(value));
  f.live.onFile(value => files.push(value));
  f.live.retry();
  assert.equal(peer.closed, false);
  assert.equal(f.live.sendInput({ kind: "keydown" }), false);
  assert.equal(await f.live.sendFile({}), false);
  await flush(); await f.advance(0);
  assert.equal(peer.stopCalls, 1);
  assert.equal(segments[0], peer.result);
  assert.equal(files[0].kind, "error");
  assert.equal(f.peers[1].isRecording, false);
  assert.equal(f.peak, 1);
  f.live.close();
});

test("a hung recording finalizer is bounded, never silently auto-records", async () => {
  const f = fixture(), segments = [];
  f.peers[0].isRecording = true;
  f.peers[0].stopRecording = () => new Promise(() => {});
  f.live.onInterruptedRecording(result => segments.push(result));
  f.peers[0].fail();
  await f.advance(4999); assert.equal(f.peers[0].closed, false);
  await f.advance(1); assert.equal(f.peers[0].closed, true);
  assert.deepEqual(segments, [null]);
  await f.advance(1000); assert.equal(f.peers.length, 2);
  f.live.close();
});

test("relay cooldown and bounded backoff are honored", async () => {
  const f = fixture();
  f.peers[0].fail("relay-unavailable", true, 90_000);
  await f.advance(89_999); assert.equal(f.peers.length, 1);
  await f.advance(1); assert.equal(f.peers.length, 2);
  for (let n = 1; n < 80; n++) assert.ok(profiles.recoveryDelay(n) <= 120_000);
  f.live.close();
});

test("VP8-only offers cannot accidentally retain H.264", () => {
  const codecs = ["VP9", "H264", "VP8", "rtx"].map(name => ({ mimeType: `video/${name}` }));
  assert.deepEqual(Array.from(profiles.preferredVideoCodecs(codecs, "vp8"), c => c.mimeType),
    ["video/VP8", "video/rtx"]);
  assert.equal(profiles.preferredVideoCodecs(codecs, "h264-preferred")[0].mimeType, "video/H264");
});

test("native JPEG quality is independent, native-sized, and within upload limits", () => {
  const root = "agent/src/";
  const encoder = fs.readFileSync(root + "JpegFallbackEncoder.cs", "utf8");
  const capture = fs.readFileSync(root + "ScreenCapture.cs", "utf8");
  const max = Number(encoder.match(/MaxBytes = ([\d_]+)/)[1].replaceAll("_", ""));
  assert.ok(4 * Math.ceil(max / 3) <= 2_000_000);
  assert.match(encoder, /MaxEdge = 3840/);
  assert.match(encoder, /MotionQuality = 86/);
  assert.match(encoder, /IdleQuality = 94/);
  assert.match(encoder, /Math\.Min\(1\.0/);
  assert.match(capture, /JpegFallbackEncoder\.Encode\(rawBmp, idle\)/);
  assert.doesNotMatch(capture, /rung\.(MotionQuality|IdleQuality)/);
  assert.match(capture, /if \(jpegDirty \|\| !latestJpeg\.HasValue/);
  const native = fs.readFileSync(root + "WebRtcSession.cs", "utf8");
  assert.match(native, /Vp8FrameEncoder\.TryCreate\(\)/);
  assert.doesNotMatch(native, /GetVideoSourceFormats\(\)/);
  assert.match(native, /FailCodec\(pc, hardware: true\)/);
});
