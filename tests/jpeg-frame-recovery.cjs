// Exercise the real viewer subscription effect with isolated clocks/transports.
// No browser credentials, real database, device or network is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");

const path = "src/routes/_authenticated/console.tsx";
const source = ts.createSourceFile(path, fs.readFileSync(path, "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "useEffect" &&
      node.arguments[0]?.getText(source).includes('.from("session_frames")')) {
    assert.equal(effect, undefined, "expected one frame subscription effect");
    effect = node.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(effect, "frame subscription effect must exist");
const compiled = ts.transpileModule(`module.exports = (${effect});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function fixture({ mediaMode = "legacy", videoDecoding = false, viewerPaused = false } = {}) {
  let now = 10000;
  let tick;
  let removed = false;
  const reads = { session_frames: 0, session_cursors: 0 };
  const handlers = {};
  const channel = {
    on(_event, filter, handler) { handlers[filter.table] = handler; return this; },
    subscribe(handler) { handler("SUBSCRIBED"); return this; },
  };
  const context = {
    module: { exports: {} },
    Date: class extends Date { static now() { return now; } },
    liveId: "fixture-session",
    currentLiveSession: { media_mode: mediaMode },
    videoDecoding, viewerPaused,
    setLiveFrame() {}, setLiveCursor() {}, setSharedNote() {}, setRealtimeStatus() {},
    lastRealtimePushAtRef: { current: 0 },
    lastFramePushAtRef: { current: 0 },
    lastCursorPushAtRef: { current: 0 },
    fpsCounterRef: { current: { count: 0, lastReset: now, fps: 0 } },
    setInterval(callback) { tick = callback; return 1; },
    clearInterval() {},
    supabase: {
      from(table) {
        assert.ok(table in reads, `unexpected table ${table}`);
        return {
          select() { return this; }, eq() { return this; },
          maybeSingle() {
            reads[table]++;
            return Promise.resolve({ data: { updated_at: new Date(now).toISOString() }, error: null });
          },
        };
      },
      channel() { return channel; },
      removeChannel() { removed = true; },
    },
  };
  vm.runInNewContext(compiled, context);
  const cleanup = context.module.exports();
  await new Promise(resolve => setImmediate(resolve));
  return {
    reads,
    advance(ms) { now += ms; },
    push(table) {
      assert.ok(handlers[table], `${table} must have a subscription`);
      handlers[table]({ new: { updated_at: new Date(now).toISOString() } });
    },
    tick: () => tick(),
    cleanup,
    removed: () => removed,
  };
}

test("cursor activity cannot starve JPEG recovery when frame events stop", async () => {
  const f = await fixture();
  f.advance(6000);
  f.push("session_cursors");
  await f.tick();
  assert.equal(f.reads.session_frames, 2, "fresh cursor is not evidence of a fresh screen");
  assert.equal(f.reads.session_cursors, 1, "fresh cursor needs no duplicate poll");
  f.cleanup();
});

test("frame activity cannot starve independent cursor recovery", async () => {
  const f = await fixture();
  f.advance(6000);
  f.push("session_frames");
  await f.tick();
  assert.equal(f.reads.session_frames, 1);
  assert.equal(f.reads.session_cursors, 2);
  f.cleanup();
});

test("healthy frame and cursor subscriptions avoid redundant polling", async () => {
  const f = await fixture();
  f.advance(1000);
  f.push("session_frames");
  f.push("session_cursors");
  await f.tick();
  assert.deepEqual(f.reads, { session_frames: 1, session_cursors: 1 });
  f.cleanup();
});

for (const options of [{ mediaMode: "video" }, { videoDecoding: true }, { viewerPaused: true }]) {
  test(`JPEG remains off for ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    f.advance(6000);
    await f.tick();
    assert.equal(f.reads.session_frames, 0);
    assert.equal(f.reads.session_cursors, 2);
    f.cleanup();
  });
}

test("closing the viewer cancels recovery polling", async () => {
  const f = await fixture();
  f.cleanup();
  f.advance(6000);
  await f.tick();
  assert.equal(f.removed(), true);
  assert.deepEqual(f.reads, { session_frames: 1, session_cursors: 1 });
});
