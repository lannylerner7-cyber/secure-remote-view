const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load, diagnosticsFixture } = require("./helpers/agent-http.cjs");
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

function fixture() {
  const clock = diagnosticsFixture();
  const helper = load("lib/bounded-telemetry.server.ts", {}, { ...clock.clock, AbortController });
  const parent = new AbortController();
  return { ...clock, parent, write: work => helper.writeBoundedTelemetry(parent.signal, work) };
}

test("healthy optional metadata writes clear their deadline", async () => {
  const f = fixture();
  assert.equal(await f.write(async () => ({ error: null })), true);
  assert.equal(f.timers.size, 0);
});

test("an already cancelled request does not start a metadata query", async () => {
  const f = fixture();
  f.parent.abort();
  assert.equal(await f.write(() => { throw Error("must not start"); }), false);
  assert.equal(f.timers.size, 0);
});

test("request cancellation reaches an in-flight metadata query immediately", async () => {
  const f = fixture();
  let signal;
  const pending = f.write(value => { signal = value; return new Promise(() => {}); });
  await flush();
  f.parent.abort();
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test("deadline resolves even when an upstream query ignores cancellation", async () => {
  const f = fixture();
  let signal, reject;
  const pending = f.write(value => {
    signal = value;
    return new Promise((_resolve, fail) => { reject = fail; });
  });
  await flush();
  f.advance(1_000);
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  reject(Error("late failure must be observed"));
  await flush();
  assert.equal(f.timers.size, 0);
});
