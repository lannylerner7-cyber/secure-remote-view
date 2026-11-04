const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const nested = path.join(root, ".");
const app = fs.existsSync(path.join(nested, "bun.lock")) ? nested : root;

function checkRegistryUrls(lockfile) {
  const urls = [...lockfile.matchAll(/"([a-z][a-z0-9+.-]*:\/\/[^"\r\n]+)"/gi)];
  for (const [, value] of urls) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    assert.equal(url.protocol, "https:", "Deployment package URLs must use HTTPS");
    assert.ok(!url.username && !url.password, "Do not commit package credentials");
    assert.ok(
      host.includes(".") &&
        !/(^|\.)(internal|local|localhost|test|invalid)$/.test(host) &&
        !net.isIP(host),
      `Deployment lockfile contains a non-public package host: ${host}`,
    );
  }
  return urls.length;
}

// Check the guard itself, not just today's lockfile.
for (const url of [
  "http://package-firewall.replit.internal/npm/example.tgz",
  "https://package-firewall.replit.internal/npm/example.tgz",
  "https://localhost/example.tgz",
  "https://127.0.0.1/example.tgz",
  "https://[::1]/example.tgz",
  "https://token@example.org/example.tgz",
]) {
  assert.throws(() => checkRegistryUrls(JSON.stringify([url])));
}
assert.equal(
  checkRegistryUrls('["https://registry.npmjs.org/example/-/example-1.0.0.tgz"]'),
  1,
);

const count = checkRegistryUrls(fs.readFileSync(path.join(app, "bun.lock"), "utf8"));
console.log(`PASS: ${count} explicit package URLs use credential-free, public HTTPS hosts.`);
