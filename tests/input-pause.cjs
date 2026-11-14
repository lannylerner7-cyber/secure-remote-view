const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto").webcrypto;

function fixture() {
  const exports = {}, timers = new Map(), messages = [];
  let timerId = 0, uncertain = 0, mode = "control";
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(
    "src/lib/browser-input-pause.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, crypto, Error,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const session = crypto.randomUUID(), grant = crypto.randomUUID(), peer = crypto.randomUUID(), process = crypto.randomUUID();
  const control = exports.createBrowserInputPause({
    sessionId: session, authorizationId: grant, peerId: peer, controllerId: "web-test",
    mode: () => mode, send: value => { messages.push(value); return true; },
    uncertain: () => uncertain++,
  });
  let revision = 0, epoch = crypto.randomUUID();
  function frame(paused, overrides = {}) {
    return { kind: "permission_status", session_id: session, authorization_id: grant,
      mode, peer_id: peer, process_id: process, controller_id: "web-test",
      input_pause_supported: true, input_pause_protocol: 1, input_paused: paused,
      input_epoch: epoch, input_revision: revision, input_release_confirmed: true, ...overrides };
  }
  function acknowledge(paused, overrides = {}) {
    revision++; epoch = crypto.randomUUID();
    const value = frame(paused, { kind: "input_pause_status", action: "input_pause",
      request_id: messages.at(-1).payload.request_id, status: "applied", ...overrides });
    control.receive(value);
    return value;
  }
  control.receive(frame(true));
  return { control, messages, timers, frame, acknowledge,
    get uncertain() { return uncertain; }, get epoch() { return epoch; },
    mode(value) { mode = value; } };
}

test("pause is synchronous locally but success requires a bound Agent receipt", async () => {
  const f = fixture();
  assert.equal(f.control.state().phase, "paused");
  const starting = f.control.setPaused(false);
  assert.equal(f.control.state().phase, "resuming");
  assert.equal(f.control.allowed(), false);
  f.control.receive(f.frame(false, { kind: "input_pause_status", action: "input_pause",
    request_id: "wrong", status: "applied" }));
  assert.equal(f.control.state().phase, "resuming");
  f.acknowledge(false); await starting;
  assert.equal(f.control.allowed(), true);
  const pause = f.control.setPaused(true);
  assert.equal(f.control.allowed(), false);
  assert.equal(f.control.state().phase, "pausing");
  assert.equal(f.control.prepareInput({ kind: "keydown", payload: { vk: 65 } }), null);
  f.acknowledge(true); await pause;
  assert.equal(f.control.state().phase, "paused");
  assert.equal(f.messages.some(m => m.kind.startsWith("curtain")), false);
});

test("old epochs and delayed acknowledgements cannot revive input", async () => {
  const f = fixture();
  let work = f.control.setPaused(false);
  const oldAck = f.acknowledge(false); await work;
  const oldEpoch = f.epoch;
  work = f.control.setPaused(true); f.acknowledge(true); await work;
  f.control.receive(oldAck);
  assert.equal(f.control.state().phase, "paused");
  work = f.control.setPaused(false); f.acknowledge(false); await work;
  assert.equal(f.control.prepareInput({ kind: "mousemove", payload: { x: .5, y: .5, input_epoch: oldEpoch } }), null);
  const current = f.control.prepareInput({ kind: "mousemove", payload: { x: .5, input_epoch: f.epoch } });
  assert.equal(current.payload.input_epoch, f.epoch);
  const cleanup = f.control.prepareInput({ kind: "release_inputs", payload: {} });
  assert.equal(cleanup.kind, "release_keys");
  assert.equal(cleanup.payload.input_epoch, f.epoch);
});

test("foreign bindings and false cleanup claims do not confirm pause", async () => {
  const f = fixture();
  f.control.receive(f.frame(false, { peer_id: crypto.randomUUID(), input_revision: 9 }));
  assert.equal(f.control.state().phase, "paused");
  const work = f.control.setPaused(false).catch(error => error);
  f.acknowledge(false, { input_release_confirmed: false });
  assert.match((await work).message, /could not confirm/);
  assert.equal(f.control.allowed(), false);
  assert.equal(f.control.state().phase, "unknown");
});

test("timeout/cancellation keep input blocked even after a late resume", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), controller = new AbortController();
    const work = f.control.setPaused(false, controller.signal).catch(error => error);
    if (cancel) controller.abort(); else for (const fn of [...f.timers.values()]) fn();
    assert.ok(await work instanceof Error);
    assert.equal(f.uncertain, 1);
    f.acknowledge(false);
    assert.equal(f.control.allowed(), false);
    assert.equal(f.control.state().phase, "unknown");
  }
});

test("reconnect never automatically resumes or downgrades a supported Agent", async () => {
  const f = fixture();
  const work = f.control.setPaused(false); f.acknowledge(false); await work;
  f.control.reset();
  assert.equal(f.control.allowed(), false);
  f.control.receive({ ...f.frame(false), input_pause_supported: false });
  assert.equal(f.control.state().phase, "unknown");
  f.control.receive(f.frame(true));
  assert.equal(f.control.state().phase, "paused");
  f.mode("view");
  await assert.rejects(f.control.setPaused(false), /Take control/);
});

test("legacy Agent behavior is explicitly unsupported, not a simulated pause", async () => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/browser-input-pause.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, crypto, Error, setTimeout, clearTimeout });
  const c = exports.createBrowserInputPause({ sessionId: "s", authorizationId: "g",
    mode: () => "control", send: () => true, uncertain() {} });
  c.receive({ kind: "permission_status", session_id: "s", authorization_id: "g", mode: "control" });
  assert.equal(c.state().phase, "unsupported");
  assert.equal(c.allowed(), true);
  await assert.rejects(c.setPaused(true), /has not confirmed support/);
});

test("combined control opens input only after the curtain is acknowledged", async () => {
  const exports = {}, events = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/lib/control-curtain.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, AbortController, Error, setTimeout, clearTimeout });
  let curtain = false;
  const peer = {
    state: () => "connected",
    onAgentMode(fn) { fn("control"); return () => {}; }, onState() { return () => {}; },
    setCurtain: async value => { curtain = value; events.push("curtain"); },
    sendInput: () => true,
    inputPause: () => ({ supported: true, phase: "paused" }),
    setInputPaused: async value => { assert.equal(curtain, true); assert.equal(value, false); events.push("resume"); },
  };
  await exports.takeControlAndCurtain({ peer, initialMode: "control",
    signal: new AbortController().signal, isCurrent: () => true, isSamePeer: () => true,
    setMode: async () => {}, onStage: value => events.push(value) });
  assert.ok(events.indexOf("resume") > events.indexOf("curtain"));
  assert.equal(events.at(-1), "active");
});
