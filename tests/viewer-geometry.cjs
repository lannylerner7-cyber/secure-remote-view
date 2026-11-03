// Pure geometry tests. These do not operate an Agent or claim Windows coverage.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const sourcePath = path.join(__dirname, "../src/lib/viewer-geometry.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function("exports", "module", js)(mod.exports, mod);
const { computeContentRect, validSourceSize, formatScale } = mod.exports;

const cases = [
  ["landscape", { width: 2560, height: 1440 }, { width: 800, height: 600 }, 800, 450],
  ["portrait", { width: 1080, height: 2340 }, { width: 1000, height: 700 }, 700 * 1080 / 2340, 700],
  ["ultrawide", { width: 5120, height: 1440 }, { width: 960, height: 500 }, 960, 270],
  ["4:3", { width: 1600, height: 1200 }, { width: 900, height: 600 }, 800, 600],
  ["no enlargement", { width: 640, height: 480 }, { width: 1200, height: 900 }, 640, 480],
  ["fractional fit", { width: 1366, height: 768 }, { width: 901, height: 451 }, 1366 * 451 / 768, 451],
  ["phone viewport", { width: 1920, height: 1080 }, { width: 358, height: 460 }, 358, 358 * 1080 / 1920],
  ["tiny available area", { width: 1, height: 10000 }, { width: 0.1, height: 0.1 }, 0.00001, 0.1],
];
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-8, `${label}: ${a} != ${b}`);
for (const [name, size, available, width, height] of cases) {
  const fit = computeContentRect(size, available, "fit");
  near(fit.width, width, name);
  near(fit.height, height, name);
  near(fit.width / fit.height, size.width / size.height, `${name} source ratio`);
  assert.ok(fit.scale > 0 && fit.scale <= 1);
  assert.ok(fit.width <= available.width + 1e-8 && fit.height <= available.height + 1e-8);
  assert.deepEqual(computeContentRect(size, available, "actual"), { ...size, scale: 1 });
}
for (const size of [
  null, { width: 0, height: 1 }, { width: 1, height: 0 },
  { width: -1, height: 2 }, { width: NaN, height: 20 },
  { width: 20, height: Infinity }, { width: "1920", height: 1080 },
]) {
  assert.equal(validSourceSize(size), false);
  assert.equal(computeContentRect(size, { width: 100, height: 100 }, "fit"), null);
  assert.equal(computeContentRect(size, { width: 100, height: 100 }, "actual"), null);
}
for (const available of [
  { width: 0, height: 200 }, { width: 200, height: 0 },
  { width: NaN, height: 200 }, { width: 200, height: Infinity },
]) {
  assert.equal(computeContentRect({ width: 800, height: 600 }, available, "fit"), null);
}
assert.equal(formatScale(1), "100%");
assert.equal(formatScale(0.3125), "31.3%");
const previewDir = path.join(__dirname, "../artifacts/mockup-sandbox/src/components/mockups/connectlive-viewer/_shared");
assert.equal(fs.readFileSync(path.join(previewDir, "viewer-geometry.ts"), "utf8"), source,
  "Preview must use an exact copy of real geometry, not a separate approximation");
const wrapper = fs.readFileSync(path.join(__dirname, "../src/components/console/RemoteDisplayFrame.tsx"), "utf8");
assert.equal(fs.readFileSync(path.join(previewDir, "RemoteDisplayFrame.tsx"), "utf8"),
  wrapper.replace('"@/lib/viewer-geometry"', '"./viewer-geometry"'),
  "Preview must use the actual extracted wrapper");
console.log(`PASS: ${cases.length} source/viewport pairs, 1:1 scrolling geometry, invalid/unknown metadata and scale labels`);
