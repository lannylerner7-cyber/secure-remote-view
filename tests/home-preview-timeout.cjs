const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const appRequire = createRequire(path.resolve("package.json"));
const ts = appRequire("typescript");

function fixture(development, readCatalog) {
  let deadline, ms, cleared = false, signal;
  const source = fs.readFileSync("src/routes/index.tsx", "utf8")
    .replaceAll("import.meta.env.DEV", String(development));
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, AbortController,
    setTimeout(fn, delay) { deadline = fn; ms = delay; return 1; },
    clearTimeout() { cleared = true; },
    require(name) {
      if (name === "@tanstack/react-router") return { createFileRoute: () => options => options };
      if (name === "@/lib/orders.functions") return { getActivePlansPublic(options) {
        signal = options?.signal;
        return readCatalog(options);
      } };
      return {};
    },
  });
  return { run: exports.Route.loader, expire: () => deadline?.(),
    get ms() { return ms; }, get cleared() { return cleared; }, get signal() { return signal; } };
}

test("development homepage expires at three seconds without fabricating prices", async () => {
  const f = fixture(true, () => new Promise(() => {}));
  const request = f.run();
  assert.equal(f.ms, 3000);
  f.expire();
  const result = await request;
  assert.equal(result.catalog.plans, null);
  assert.match(result.catalog.error, /Current prices are temporarily unavailable/);
  assert.equal(f.signal.aborted, true);
  assert.equal(f.cleared, true);
});

test("production has no preview timer or abort and returns the catalog unchanged", async () => {
  const plans = [{ id: "synthetic-plan", price: 123 }];
  const f = fixture(false, async () => plans);
  const result = await f.run();
  assert.equal(result.catalog.plans, plans);
  assert.equal(result.catalog.error, null);
  assert.equal(f.ms, undefined);
  assert.equal(f.signal, undefined);
});

test("a successful development lookup clears the timer without cancelling it", async () => {
  const f = fixture(true, async () => []);
  const result = await f.run();
  assert.equal(result.catalog.error, null);
  assert.equal(f.signal.aborted, false);
  assert.equal(f.cleared, true);
});
