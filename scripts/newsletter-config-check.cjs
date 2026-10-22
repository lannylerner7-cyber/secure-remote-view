// Isolated test: no application boot, real env values, database or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const ts = require("typescript");

const source = fs.readFileSync("src/lib/newsletter-unsub.server.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load(secret) {
  const exports = {};
  const context = vm.createContext({
    exports,
    process: { env: { SUPABASE_SERVICE_ROLE_KEY: secret } },
    TextEncoder,
    btoa,
    crypto: webcrypto,
  });
  vm.runInContext(compiled, context);
  return exports;
}

(async () => {
  for (const missing of [undefined, "", "   "]) {
    const api = load(missing);
    await assert.rejects(api.unsubToken("test@example.invalid"), /configuration is missing/);
    assert.equal(await api.verifyUnsubToken("test@example.invalid", "forged"), false);
  }
  const api = load("synthetic-test-key-not-a-credential");
  const token = await api.unsubToken("test@example.invalid");
  assert.equal(await api.verifyUnsubToken(" TEST@example.invalid ", token), true);
  assert.equal(await api.verifyUnsubToken("other@example.invalid", token), false);
  assert.equal(await api.verifyUnsubToken("test@example.invalid", token + "x"), false);
  assert.equal(await load("different-test-key").verifyUnsubToken("test@example.invalid", token), false);
  console.log("PASS: missing configuration rejected; valid, mismatched and rotated-key cases verified.");
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
