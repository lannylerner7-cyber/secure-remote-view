// Run the actual video freshness observer with isolated frame callbacks/clocks.
// No WebRTC server, customer device, credentials or database is involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");

const compiled = ts.transpileModule(
  fs.readFileSync("src/lib/video-frame-health.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture({ frameCallbacks = true, initialTotal = 0 } = {}) {
  let now = 0, nextId = 0, total = initialTotal;
  const timers = new Map(), callbacks = new Map(), samples = [];
  const video = {
    paused: false,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: total }),
    ...(frameCallbacks ? {
      requestVideoFrameCallback(callback) {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancelVideoFrameCallback(id) { callbacks.delete(id); },
    } : {}),
  };
  const context = {
    exports: {},
    performance: { now: () => now },
    window: {
      setInterval(callback) {
        const id = ++nextId;
        timers.set(id, callback);
        return id;
      },
      clearInterval(id) { timers.delete(id); },
    },
  };
  vm.runInNewContext(compiled, context);
  const stop = context.exports.observeVideoFrames(video, sample => samples.push({ ...sample }));
  return {
    video, samples, stop,
    latest: () => samples.at(-1),
    advance(ms = 1000) { now += ms; for (const tick of timers.values()) tick(); },
    frame() {
      total++;
      for (const [id, callback] of [...callbacks]) { callbacks.delete(id); callback(); }
    },
    total(value) { total = value; },
    activeTimers: () => timers.size + callbacks.size,
    callbacks,
  };
}

test("no decoded frames never counts as live, even with connected ICE", () => {
  const f = fixture();
  f.advance(30000);
  assert.deepEqual(f.latest(), { decoding: false, fps: 0 });
  f.stop();
});

test("presented video becomes stale after five seconds without new pixels", () => {
  const f = fixture();
  f.frame();
  assert.equal(f.latest().decoding, true);
  f.advance(4999);
  assert.equal(f.latest().decoding, true);
  f.advance(1);
  assert.deepEqual(f.latest(), { decoding: false, fps: 0 });
  f.stop();
});

test("unexpected media-element pause cannot keep an old frame marked live", () => {
  const f = fixture();
  f.frame();
  f.video.paused = true;
  f.advance(5000);
  assert.equal(f.latest().decoding, false);
  f.stop();
});

test("fresh frames after a stall restore video automatically", () => {
  const f = fixture();
  f.frame();
  f.advance(6000);
  assert.equal(f.latest().decoding, false);
  f.frame();
  assert.equal(f.latest().decoding, true);
  for (let i = 0; i < 14; i++) f.frame();
  f.advance(1000);
  assert.deepEqual(f.latest(), { decoding: true, fps: 15 });
  f.stop();
});

test("older browsers need a progressing counter, not historical nonzero frames", () => {
  const f = fixture({ frameCallbacks: false, initialTotal: 200 });
  f.advance();
  assert.equal(f.latest().decoding, false);
  f.total(215);
  f.advance();
  assert.deepEqual(f.latest(), { decoding: true, fps: 15 });
  f.advance(5000);
  assert.deepEqual(f.latest(), { decoding: false, fps: 0 });
  f.total(216);
  f.advance();
  assert.equal(f.latest().decoding, true);
  f.stop();
});

test("a reset frame counter does not count as new video", () => {
  const f = fixture({ frameCallbacks: false, initialTotal: 200 });
  f.total(0);
  f.advance();
  assert.equal(f.latest().decoding, false);
  f.total(1);
  f.advance();
  assert.equal(f.latest().decoding, true);
  f.stop();
});

test("closing or replacing a peer cancels its timers and late callbacks", () => {
  const f = fixture();
  const late = [...f.callbacks.values()][0];
  f.frame();
  const before = f.samples.length;
  f.stop();
  late();
  f.advance(6000);
  assert.equal(f.samples.length, before);
  assert.equal(f.activeTimers(), 0);
  const replacement = fixture();
  assert.deepEqual(replacement.latest(), { decoding: false, fps: 0 });
  replacement.stop();
});
