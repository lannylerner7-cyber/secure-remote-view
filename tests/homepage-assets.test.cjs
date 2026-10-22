const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(".");
const source = fs.readFileSync(path.join(root, "src/routes/index.tsx"), "utf8");
assert.ok(!source.includes(".asset.json"), "Homepage must bundle media, not import Lovable asset metadata");
assert.ok(!source.includes("/__l5e/"), "Lovable asset proxy is unavailable on Coolify");
for (const match of source.matchAll(/import\s+\w+\s+from\s+["']@\/assets\/([^"']+)["']/g)) {
  const file = path.join(root, "src/assets", match[1]);
  assert.ok(fs.statSync(file).size > 0, `Missing homepage asset: ${match[1]}`);
}
const banner = fs.readFileSync(path.join(root, "src/assets/connectlive-banner.jpg"));
assert.equal(banner.length, 63170, "Recovered original banner must be complete");
assert.equal(banner.subarray(0, 3).toString("hex"), "ffd8ff");
assert.ok(source.includes('new URL(bannerImage, "https://connectliveagent.com").href'));
console.log("Homepage asset packaging checks passed");
