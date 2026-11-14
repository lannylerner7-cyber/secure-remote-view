const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(
  "src/lib/video-stall-guard.ts", "utf8",
), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
{ exports: exports_ });

test("one keyframe hint has a bounded grace period and is not evidence of recovery", () => {
  let requests = 0;
  const guard = exports_.createVideoStallGuard(() => { requests++; return true; });
  assert.equal(guard.check(7_999, 0), "wait");
  assert.equal(guard.check(8_000, 0), "keyframe");
  assert.equal(guard.check(11_999, 0), "wait");
  assert.equal(guard.check(12_000, 0), "recover");
  assert.equal(guard.check(15_000, 0), "recover");
  assert.equal(requests, 1);
});

test("only actual newer frames renew the recovery budget", () => {
  let requests = 0;
  const guard = exports_.createVideoStallGuard(() => { requests++; return true; });
  assert.equal(guard.check(8_000, 0), "keyframe");
  assert.equal(guard.check(10_000, 10_000), "wait");
  assert.equal(guard.check(17_999, 10_000), "wait");
  assert.equal(guard.check(18_000, 10_000), "keyframe");
  assert.equal(requests, 2);
});

test("legacy or congested peers use the existing recovery path immediately", () => {
  const guard = exports_.createVideoStallGuard(() => false);
  assert.equal(guard.check(8_000, 0), "recover");
});

test("changing stats failure thresholds cannot repeat or extend a pending hint", () => {
  let requests = 0;
  const guard = exports_.createVideoStallGuard(() => { requests++; return true; });
  assert.equal(guard.check(8_000, 0), "keyframe");
  assert.equal(guard.check(9_000, 0, 12_000), "wait");
  assert.equal(guard.check(12_000, 0, 12_000), "recover");
  assert.equal(requests, 1);
});

test("advancing presentation prevents a stats-only false disconnection", () => {
  const guard = exports_.createVideoStallGuard(() => { throw Error("unnecessary recovery"); });
  for (let now = 1_000; now <= 60_000; now += 3_000)
    assert.equal(guard.check(now, now - 500, 12_000), "wait");
});

test("a deliberate pause resets the bounded recovery attempt", () => {
  const guard = exports_.createVideoStallGuard(() => true);
  assert.equal(guard.check(8_000, 0), "keyframe");
  guard.reset();
  assert.equal(guard.check(30_000, 30_000), "wait");
  assert.equal(guard.check(38_000, 30_000), "keyframe");
});

test("the live viewer ties recovery to real frames and serializes stats calls", () => {
  const rtc = fs.readFileSync("src/lib/webrtc-live.ts", "utf8");
  assert.match(rtc, /Math\.max\(lastMediaProgressAt, lastPresentedAt \?\? 0\)/);
  assert.match(rtc, /if \(statsInFlight\)/);
  assert.match(rtc, /finally\(\(\) => \{ statsInFlight = false/);
  assert.match(rtc, /actions\.requestVideoKeyFrame\(\)/);
});
