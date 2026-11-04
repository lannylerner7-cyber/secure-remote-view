const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = createRequire(path.resolve("package.json"))("typescript");

// Exercise the actual loader and eligibility expression without a browser,
// network requests, database writes, or a mocked React rendering lifecycle.
const filename = "src/components/console/DevicePairingDialog.tsx";
const source = fs.readFileSync(filename, "utf8");
const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let loader, eligibility, errorHelper;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "load")
    loader = node.initializer.arguments[0].getText(tree);
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "canCreate")
    eligibility = node.initializer.getText(tree);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "errorText")
    errorHelper = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(loader && eligibility && errorHelper, "test the real component implementation");

const state = { licenses: [{ id: "old" }], loading: false, loadError: null, licenseId: "old" };
const loadGeneration = { current: 0 };
const requests = [];
const moduleUnderTest = { exports: {} };
const code = `${errorHelper}
const load = ${loader};
const canCreate = (selected, loading, loadError, creating, issued) => (${eligibility});
module.exports = { load, canCreate, errorText };`;
vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module: moduleUnderTest, Error,
  loadGeneration,
  listRef: { current: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) },
  setLoading: value => { state.loading = value; },
  setLoadError: value => { state.loadError = value; },
  setLicenses: value => { state.licenses = value; },
  setLicenseId: value => { state.licenseId = typeof value === "function" ? value(state.licenseId) : value; },
});
const api = moduleUnderTest.exports;
const license = id => ({ id, organization: "Test organization", expiresAt: "2030-01-01T00:00:00Z", seatLimit: 5 });
function start() {
  const promise = api.load();
  return { promise, ...requests.at(-1) };
}

async function main() {
  let request = start();
  assert.equal(state.loading, true);
  assert.equal(state.licenses, null, "a new load clears stale selections");
  request.resolve([license("first")]);
  await request.promise;
  assert.equal(state.licenseId, "first");
  assert.equal(state.loading, false);

  const earlier = start();
  const latest = start();
  earlier.resolve([license("stale")]);
  await earlier.promise;
  assert.equal(state.loading, true, "an old response cannot end the current loading state");
  assert.equal(state.licenses, null);
  latest.resolve([license("latest")]);
  await latest.promise;
  assert.equal(state.licenseId, "latest");

  request = start();
  request.reject(new TypeError("Load failed"));
  await request.promise;
  assert.match(state.loadError, /could not reach the server/);
  assert.equal(state.licenses, null);
  assert.equal(state.loading, false);
  request = start();
  assert.equal(state.loadError, null, "retry clears the previous error");
  request.resolve([license("retry")]);
  await request.promise;
  assert.equal(state.licenseId, "retry");

  for (const malformed of [{ rows: [] }, [null], [{ id: "incomplete" }]]) {
    request = start();
    request.resolve(malformed);
    await request.promise;
    assert.match(state.loadError, /invalid license list/);
    assert.equal(state.licenses, null);
    assert.equal(state.loading, false);
  }

  request = start();
  loadGeneration.current += 1; // Effect cleanup when closing/unmounting.
  state.loading = false;
  request.resolve([license("closed")]);
  await request.promise;
  assert.equal(state.licenses, null, "closed-dialog responses are ignored");
  assert.equal(state.loading, false);
  assert.match(source, /return \(\) => \{ loadGeneration\.current \+= 1; \}/);

  assert.equal(api.errorText({ message: "Session expired" }, "fallback"), "Session expired");
  assert.equal(api.canCreate(license("ready"), false, null, false, null), true);
  assert.equal(api.canCreate(license("ready"), true, null, false, null), false);
  assert.equal(api.canCreate(license("ready"), false, "failed", false, null), false);
  assert.equal(api.canCreate(license("ready"), false, null, true, null), false);
  assert.equal(api.canCreate(license("ready"), false, null, false, {}), false);
  assert.match(source, /if \(!canCreate \|\| !selected \|\| createLock\.current\) return/);
  assert.match(source, /Loading eligible organization licenses/);
  console.log("PASS: pairing loading, stale responses, retry, malformed data, closed-dialog cleanup, and create guards");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
