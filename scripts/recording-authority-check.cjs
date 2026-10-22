const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const ts = require("typescript");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(
  fs.readFileSync("src/lib/recording-authority.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { exports: exportsObject });
const { RecordingAuthority } = exportsObject;
(async () => {
  let now = 100, answer = null, calls = 0;
  const lease = new RecordingAuthority(async () => { calls++; return answer; }, () => now);
  assert.equal(lease.valid(), false);
  assert.equal(await lease.authorize(), false); // view-only/declined recording
  assert.equal(lease.valid(), false);
  answer = "grant-a";
  assert.equal(await lease.authorize(), true);
  assert.equal(lease.valid(), true);
  now += 2000;
  assert.equal(await lease.authorize(true), true);
  answer = null;
  assert.equal(await lease.authorize(true), false);
  assert.equal(lease.valid(), false); // revoked => no recording/save
  answer = "grant-a";
  assert.equal(await lease.authorize(), true);
  now += 5000;
  const before = calls;
  assert.equal(await lease.authorize(true), false);
  assert.equal(calls, before); // expiration cannot be renewed
  assert.equal(await lease.authorize(), true);
  answer = "grant-b";
  assert.equal(await lease.authorize(true), false); // replacement isn't the old grant
  const failure = new RecordingAuthority(async () => { throw Error("offline"); }, () => now);
  assert.equal(await failure.authorize(), false);
  let resolve;
  const delayed = new RecordingAuthority(() => new Promise(r => { resolve = r; }), () => now);
  const pending = delayed.authorize();
  delayed.invalidate();
  resolve("grant-a");
  assert.equal(await pending, false); // late response after local stop
  const slow = new RecordingAuthority(async () => { now += 5000; return "grant-a"; }, () => now);
  assert.equal(await slow.authorize(), false);
  console.log("16 recording-authority assertions passed (actual lease implementation; no browser/runtime calls).");
})().catch(e => { console.error(e); process.exitCode = 1; });
