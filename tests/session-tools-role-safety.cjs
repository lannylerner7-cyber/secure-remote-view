const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const root = "src";
const source = ts.createSourceFile("console.tsx",
  fs.readFileSync(`${root}/routes/_authenticated/console.tsx`, "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Exercise the real sender/handler bodies, including their mutable-context
// checks. Only browser, transport and database side effects are substituted.
function loadFunction(name, context) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert(found, `missing actual ${name} implementation`);
  const code = ts.transpileModule(found.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(`${code}\nthis.actual = ${name};`, context);
  return context.actual;
}

function sender() {
  const sent = [], secureSent = [];
  let secure = { phase: "idle", requestId: null };
  const live = {
    sessionId: "session-a", unlockState: () => secure,
    sensitiveInput: () => secure.phase === "ready",
    inputAllowed: () => true, inputPause: () => ({ epoch: "epoch-a" }),
    sendInput: value => { sent.push(value); return true; },
    sendUnlockInput: (kind, payload) => secureSent.push({ kind, payload }),
  };
  const context = {
    rtcRef: { current: live },
    currentLiveSession: { authorization_id: "grant-a" },
    controlContextRef: { current: {
      sessionId: "session-a", authorizationId: "grant-a", allowed: true, canOperate: true,
    } },
    role: "admin", viewerPaused: false, controlReady: true,
    windowsUnlock: { phase: "idle", requestId: null },
    inputPause: { supported: true, epoch: "epoch-a" },
    sessions: [{ id: "session-a", media_mode: "video" }],
  };
  return { context, sent, secureSent, send: loadFunction("sendInput", context),
    secure: value => { secure = value; } };
}

test("delayed ordinary input cannot reuse a stale render's staff role", async () => {
  const f = sender();
  await f.send("session-a", "keydown", { vk: 65 });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.input_epoch, "epoch-a");
  f.context.controlContextRef.current.allowed = false;
  f.context.controlContextRef.current.canOperate = false;
  // The captured render still says admin/ready; the current context wins.
  await f.send("session-a", "keydown", { vk: 66 });
  assert.equal(f.sent.length, 1);
});

test("a changed grant or session blocks queued input even before peer teardown", async () => {
  const f = sender();
  f.context.controlContextRef.current.authorizationId = "replacement-grant";
  await f.send("session-a", "mousemove", { x: 0.2, y: 0.5 });
  f.context.controlContextRef.current.authorizationId = "grant-a";
  f.context.controlContextRef.current.sessionId = "replacement-session";
  await f.send("session-a", "keydown", { vk: 65 });
  assert.equal(f.sent.length, 0);
});

test("safety cleanup remains possible after ordinary control is withdrawn", async () => {
  const f = sender();
  f.context.controlContextRef.current.allowed = false;
  await f.send("session-a", "release_inputs", {});
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].kind, "release_inputs");
});

test("secure input uses its own current ticket, never stale role or request state", async () => {
  const f = sender();
  f.secure({ phase: "ready", requestId: "request-new" });
  f.context.windowsUnlock = { phase: "ready", requestId: "request-old" };
  await f.send("session-a", "keydown", { vk: 65 });
  assert.equal(f.secureSent.length, 0);
  f.context.windowsUnlock.requestId = "request-new";
  f.context.controlContextRef.current.canOperate = false;
  await f.send("session-a", "keydown", { vk: 65 });
  assert.equal(f.secureSent.length, 0);
  f.context.controlContextRef.current.canOperate = true;
  f.context.controlContextRef.current.allowed = false; // Separate secure grant.
  await f.send("session-a", "keydown", { vk: 65 });
  assert.equal(f.secureSent.length, 1);
  assert.equal(f.sent.length, 0);
});

test("readonly mutation handlers return before database, input or confirmation effects", async () => {
  const errors = [];
  const context = { canMutate: false, toast: { error: value => errors.push(value) } };
  assert.equal(await loadFunction("endSession", context)({ id: "s" }), false);
  await loadFunction("deleteSession", context)({ id: "s" });
  assert.equal(errors.length, 2);
});

function renderTable(canMutate) {
  const exports = {}, calls = [];
  const element = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(
    `${root}/components/console/SessionsTable.tsx`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => {
    assert.equal(name, "react/jsx-runtime");
    return { jsx: element, jsxs: element, Fragment: "fragment" };
  } });
  const tree = exports.SessionsTable({
    canMutate, sessions: [{ id: "s", device_id: null, state: "active", mode: "control",
      created_at: "2026-11-11T00:00:00Z" }], devices: [], presenceOf: () => "online",
    onLive: () => calls.push("live"), onReconnect: () => calls.push("viewer-reconnect"),
    onControlTools: () => calls.push("open-control-tool"),
    onEnd: () => calls.push("end"), onDelete: () => calls.push("delete"),
  });
  const buttons = new Map();
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === "button") buttons.set(node.props.children.trim(), node.props);
    visit(node.props?.children);
  }
  visit(tree);
  return { buttons, calls };
}

test("viewer/unknown table permissions disable mutation but retain authorized viewing", () => {
  for (const role of [false, undefined]) {
    const f = renderTable(role);
    for (const name of ["Control tools", "End", "Delete"])
      assert.equal(f.buttons.get(name).disabled, true, name);
    for (const name of ["Live", "Reconnect viewer"])
      assert.notEqual(f.buttons.get(name).disabled, true, name);
    assert.deepEqual(f.calls, []);
  }
});

test("staff table control entry only opens the tool; no ambiguous mode-flip labels", () => {
  const f = renderTable(true);
  assert.equal(f.buttons.has("Pause"), false);
  assert.equal(f.buttons.has("Resume"), false);
  assert.equal(f.buttons.get("Control tools").disabled, false);
  f.buttons.get("Control tools").onClick();
  assert.deepEqual(f.calls, ["open-control-tool"]);
});
