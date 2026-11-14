const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto").webcrypto;
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

function environment() {
  let now = 0, id = 0, mode = "view", state = "connected", current = true, samePeer = true;
  const timers = new Map(), modes = new Set(), states = new Set();
  const messages = [], writes = [], stages = [], inputs = [];
  const clock = {
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
  };
  const load = file => {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, ...clock, AbortController, Error, crypto });
    return exports;
  };
  const { createBrowserCurtain } = load("src/lib/browser-curtain.ts");
  const flow = load("src/lib/control-curtain.ts");
  const curtain = createBrowserCurtain("session", "grant", value => {
    messages.push(value);
    return state === "connected";
  }, () => mode);
  curtain.permission(true, false);
  let curtainState;
  curtain.onState(value => { curtainState = value; });
  const peer = {
    state: () => state,
    onAgentMode(fn) { modes.add(fn); fn(mode); return () => modes.delete(fn); },
    onState(fn) { states.add(fn); fn(state); return () => states.delete(fn); },
    setCurtain: curtain.set,
    sendInput: value => { inputs.push(value); return state === "connected"; },
  };
  const abort = new AbortController();
  const options = {
    peer, initialMode: mode, signal: abort.signal,
    isCurrent: () => current, isSamePeer: () => samePeer,
    setMode: async value => { writes.push(value); },
    onStage: value => stages.push(value),
  };
  const env = {
    flow, curtain, options, abort, timers, messages, writes, stages, inputs,
    get curtainState() { return curtainState; },
    agentMode(value) { mode = value; for (const listener of modes) listener(value); },
    disconnect() {
      state = "failed"; samePeer = false; current = false;
      for (const listener of states) listener(state);
      curtain.reset("input_channel_disconnected");
    },
    replacePeer() { samePeer = false; current = false; },
    receipt(message = messages.at(-1), active = message.kind !== "curtain_off", status = "applied", overrides = {}) {
      curtain.receive({
        kind: "action_status", session_id: "session", authorization_id: "grant",
        action: message.kind, request_id: message.payload.request_id, active, status, ...overrides,
      });
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = until; await flush();
    },
  };
  return env;
}

test("control waits for Agent permission and a positive curtain receipt", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  await flush();
  assert.deepEqual(e.writes, ["control"]);
  assert.equal(e.stages.at(-1), "waiting-agent");
  assert.equal(e.messages.length, 0, "database success cannot apply curtain");
  e.agentMode("control"); await flush();
  assert.equal(e.messages.at(-1).kind, "curtain_on");
  assert.equal(e.stages.at(-1), "applying-curtain");
  e.receipt(undefined, true); await result;
  assert.equal(e.stages.at(-1), "active");
  assert.equal(e.curtainState.active, true);
});

test("unknown or disconnected command channels never request control", async () => {
  const e = environment();
  e.options.initialMode = null;
  await assert.rejects(e.flow.takeControlAndCurtain(e.options), /not acknowledged/);
  assert.equal(e.writes.length, 0);
  e.disconnect();
  await assert.rejects(e.flow.takeControlAndCurtain(e.options), /changed/);
  assert.equal(e.messages.length, 0);
});

test("cancel while awaiting permission never enables curtain and rolls back", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  const rejected = assert.rejects(result, /cancelled/);
  await flush();
  e.abort.abort(new Error("Control request cancelled.")); await flush();
  assert.equal(e.messages.at(-1).kind, "curtain_off");
  e.agentMode("control"); await flush();
  assert(!e.messages.some(message => message.kind === "curtain_on"));
  e.receipt(undefined, false); await rejected;
  assert.deepEqual(e.writes, ["control", "view"]);
});

test("cancel while applying curtain clears it and ignores its late receipt", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  const rejected = assert.rejects(result, /cancelled/);
  await flush(); e.agentMode("control"); await flush();
  const activation = e.messages.at(-1);
  e.abort.abort(new Error("Control request cancelled.")); await flush();
  const release = e.messages.at(-1);
  assert.equal(release.kind, "curtain_off");
  e.receipt(activation, true);
  assert.notEqual(e.curtainState.active, true);
  assert.equal(e.curtainState.pending, true, "cancelled activation cannot erase the pending release");
  e.receipt(release, false); await rejected;
  assert(!e.stages.includes("active"));
});

test("an applied receipt with inactive curtain is a failure, not success", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  const rejected = assert.rejects(result, /could not apply/);
  await flush(); e.agentMode("control"); await flush();
  e.receipt(undefined, false); await flush();
  assert.equal(e.messages.at(-1).kind, "curtain_off");
  e.receipt(undefined, false); await rejected;
  assert.deepEqual(e.writes, ["control", "view"]);
  assert(!e.stages.includes("active"));
});

test("a foreign grant receipt cannot enable the curtain", async () => {
  const e = environment();
  e.agentMode("control");
  const result = e.curtain.set(true);
  const rejected = assert.rejects(result, /unconfirmed/);
  e.receipt(undefined, true, "applied", { authorization_id: "other-grant" });
  assert.notEqual(e.curtainState.active, true);
  await e.advance(3000); await rejected;
});

test("a capture-exclusion rejection reports the exact bounded Windows failure and rolls back", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  const rejected = assert.rejects(result, /Windows rejected hiding the curtain from capture.*Windows error 87/);
  await flush(); e.agentMode("control"); await flush();
  e.receipt(undefined, false, "rejected", { reason: "capture_exclusion_failed", native_error: 87 });
  await flush();
  assert.equal(e.messages.at(-1).kind, "curtain_off");
  e.receipt(undefined, false); await rejected;
  assert.deepEqual(e.writes, ["control", "view"]);
  assert(!e.stages.includes("active"));
});

test("unknown Agent error strings and invalid error codes are never reflected into the UI", async () => {
  const e = environment();
  e.agentMode("control");
  const result = e.curtain.set(true);
  const rejected = assert.rejects(result, error => {
    assert.match(error.message, /could not apply curtain mode/);
    assert.doesNotMatch(error.message, /PRIVATE_|Windows error/);
    return true;
  });
  e.receipt(undefined, false, "rejected", { reason: "PRIVATE_UNTRUSTED_DATA", native_error: "PRIVATE_CODE" });
  await rejected;
  assert.equal(e.curtainState.reason, "agent_rejected");
});

test("missing Agent acknowledgement is bounded and requests view mode", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  const rejected = assert.rejects(result, /did not confirm/);
  await flush(); await e.advance(15000);
  assert.equal(e.messages.at(-1).kind, "curtain_off");
  e.receipt(undefined, false); await rejected;
  assert.deepEqual(e.writes, ["control", "view"]);
});

test("lost channel aborts without sending curtain to a replacement peer", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  const rejected = assert.rejects(result, /connection changed/);
  await flush(); e.disconnect(); await flush(); e.agentMode("control");
  await rejected;
  assert.equal(e.messages.length, 0);
  assert.deepEqual(e.writes, ["control", "view"]);
});

test("Agent withdrawal during curtain activation cancels input readiness", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain(e.options);
  const rejected = assert.rejects(result, /withdrew control/);
  await flush(); e.agentMode("control"); await flush();
  e.agentMode("view"); await flush();
  assert.equal(e.messages.at(-1).kind, "curtain_off");
  e.receipt(undefined, false); await rejected;
  assert(!e.stages.includes("active"));
});

test("view-mode release works with no RTC peer and never claims curtain confirmation", async () => {
  const e = environment();
  const result = await e.flow.releaseControlAndCurtain({ ...e.options, peer: null, isSamePeer: () => false });
  assert.deepEqual(e.writes, ["view"]);
  assert.equal(result.curtainConfirmed, false);
});

test("renewals require matching receipts and never reactivate after timeout", async () => {
  const e = environment();
  e.agentMode("control");
  const start = e.curtain.set(true);
  e.receipt(undefined, true); await start;
  await e.advance(1500);
  assert.equal(e.messages.at(-1).kind, "curtain_renew");
  const renewal = e.messages.at(-1);
  await e.advance(3000);
  assert.equal(e.curtainState.active, null);
  e.receipt(renewal, true);
  e.curtain.permission(true, true);
  e.curtain.receive({ kind: "curtain_state", session_id: "session", authorization_id: "grant", active: true });
  await e.advance(10000);
  assert.equal(e.messages.length, 2);
  assert.equal(e.curtainState.active, null);
});

test("Android control-only preserves permission acknowledgement without a Windows curtain", async () => {
  const e = environment();
  const result = e.flow.takeControlAndCurtain({ ...e.options, withCurtain: false });
  await flush();
  assert.equal(e.stages.at(-1), "waiting-agent");
  e.agentMode("control"); await result;
  assert.equal(e.stages.at(-1), "active");
  assert.equal(e.messages.length, 0);
  await e.flow.releaseControlAndCurtain({ ...e.options, withCurtain: false });
  assert.deepEqual(e.writes, ["control", "view"]);
  assert.equal(e.messages.length, 0);
});

test("native routing preserves both receipt formats and the fail-safe boundary", () => {
  const actions = fs.readFileSync("agent/src/WebRtcSession.Actions.cs", "utf8");
  const controller = fs.readFileSync("agent/src/CurtainController.cs", "utf8");
  const consoleSource = fs.readFileSync("src/routes/_authenticated/console.tsx", "utf8");
  assert(actions.includes('if (kind.GetString() is "curtain_on" or "curtain_off" or "curtain_renew")'));
  assert(!actions.includes('if (_videoOnly && kind.GetString()'));
  assert(actions.includes('kind = "action_status"') && actions.includes('kind = "curtain_status"'));
  assert(actions.includes('var requestId = request.GetString()'), "preserve native Guid N and browser Guid D request IDs");
  assert(actions.includes("else if (CurtainController.Renew(owner)) Receipt(true)"));
  assert(actions.includes('CurtainController.Release(owner, "admin_off");'));
  assert(actions.includes('_inputPermission.SetMode("view")'));
  assert(actions.includes("_curtainRequests.Add(requestId!)"), "expired activation IDs must not re-enable a curtain");
  assert(actions.includes("ReferenceEquals(_peerPermission, owner)"));
  assert(controller.indexOf("await CurtainOverlay.ShowRenderedAsync()") < controller.indexOf("InputBlocker.Engage("));
  assert(controller.includes('!owner.Allows("control")'));
  assert(controller.includes("InputRelay.ReleaseHeldInputs()"));
  assert(consoleSource.includes("Take control + curtain"));
  assert(consoleSource.includes("(!controlWithCurtain || curtain.active === true)"));
  assert(consoleSource.includes('normalizePlatform(liveDevice?.platform) !== "android"'));
  assert(consoleSource.includes("JPEG pictures alone cannot confirm control or curtain"));
  const overlay = fs.readFileSync("agent/src/CurtainOverlay.cs", "utf8");
  const capture = fs.readFileSync("agent/src/ScreenCapture.cs", "utf8");
  const renderCheck = overlay.slice(overlay.indexOf("internal static async Task<CurtainApplyResult> ShowRenderedAsync"));
  assert(renderCheck.indexOf("Task.WhenAll") < renderCheck.indexOf("VerifyExclusion"),
    "Verify exclusion after actual WPF rendering, not just hidden HWND creation");
  assert(overlay.includes("AllowsTransparency = false"));
  assert(overlay.includes("SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)"),
    "retain click-through using opaque constant alpha, not WPF per-pixel transparency");
  assert(overlay.includes("generation != _generation"),
    "an obsolete render must not hide a replacement curtain");
  assert(capture.indexOf("CurtainController.CaptureUnavailable()") < capture.indexOf("g.CopyFromScreen"),
    "No GDI fallback may capture an active physical curtain");
});
