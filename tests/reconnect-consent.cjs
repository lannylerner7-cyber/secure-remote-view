// Executes the real route handler against in-memory dependencies only.
// No database writes, network calls or endpoint commands are sent.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { stubDeviceAuth } = require("./helpers/device-auth.cjs");
const file = path.join(__dirname, "../src/routes/api/public/agent/session.$sessionId.reconnect.ts");
const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let session, authorized, verified, writes, authorityCalls;
const admin = {
  from(table) {
    const query = {
      select() { return query; },
      eq() { return query; },
      update() { writes.push([table, "update"]); return query; },
      insert() { writes.push([table, "insert"]); return query; },
      maybeSingle: async () => ({ data: session, error: null }),
    };
    return query;
  },
};
const dependencies = {
  "@tanstack/react-router": { createFileRoute: () => (config) => config },
  "@/lib/agent-auth.server": stubDeviceAuth(() => verified ? { admin, device: { id: "device-a" } } : null),
  "@/lib/authorization.server": { sessionAuthorized: async () => { authorityCalls++; return authorized; } },
};
const mod = { exports: {} };
new Function("require", "exports", "module", js)((name) => {
  assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
  return dependencies[name];
}, mod.exports, mod);
const post = mod.exports.Route.server.handlers.POST;
const base = {
  id: "session-a", device_id: "device-a", state: "active", mode: "view",
  consent_at: "2026-11-03T00:00:00Z", pairing_code: null,
};
async function run(value, expected, options = {}) {
  session = value;
  authorized = options.authorized ?? true;
  verified = options.verified ?? true;
  writes = [];
  authorityCalls = 0;
  const response = await post({
    request: new Request("https://example.invalid/reconnect", { method: "POST", body: "{}" }),
    params: { sessionId: "session-a" },
  });
  assert.equal(response.status, expected);
  if (expected !== 200) assert.equal(writes.length, 0, "Rejected reconnect must not update state");
}
(async () => {
  await run(base, 401, { verified: false });
  await run(null, 404);
  await run({ ...base, device_id: "another-device" }, 403);
  await run({ ...base, state: "ended" }, 409);
  await run({ ...base, consent_at: null }, 409);
  assert.equal(authorityCalls, 0, "Missing consent must fail before mutation or authority lookup");
  await run(base, 409, { authorized: false });
  await run(base, 200);
  assert.ok(writes.some(([table, operation]) => table === "sessions" && operation === "update"));
  console.log("PASS: real reconnect handler rejects unauthenticated, wrong-device, ended, unconsented and revoked sessions; existing authorized path remains available");
})().catch((error) => { console.error(error); process.exitCode = 1; });
