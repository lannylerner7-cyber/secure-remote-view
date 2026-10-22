const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(".");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const forbidden = /\/__l5e\/|https?:\/\/[^\s"'`]*(?:lovable\.|lovableproject\.|gpt-engineer-file-uploads)|__lovable|lovable-preview-auth/;
for (const file of walk(path.join(root, "src"))) {
  if (!/\.(tsx?|json|css)$/.test(file)) continue;
  assert.ok(!forbidden.test(fs.readFileSync(file, "utf8")), `Legacy runtime reference: ${file}`);
}
const client = fs.readFileSync(path.join(root, "src/integrations/supabase/client.ts"), "utf8");
assert.ok(client.includes("window.localStorage"));
assert.ok(client.includes("persistSession: true"));
assert.ok(client.includes("autoRefreshToken: true"));
console.log("Legacy runtime reference and storage invariants passed");
