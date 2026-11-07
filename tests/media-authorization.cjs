const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");
const source = fs.readFileSync(
  "src/routes/api/public/admin/session.$sessionId.authorization.ts", "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const caps = ["view", "control", "clipboard", "files", "recording"];
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

function fixture() {
  let revoked = false, finalChecks = 0;
  const pending = new Map();
  const admin = {
    auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    from: () => ({
      select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: { id: "session", device_id: "device", technician_id: "owner" } }),
    }),
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, Response,
    require(name) {
      if (name === "@tanstack/react-router") return { createFileRoute: () => config => config };
      if (name === "@/lib/server-supabase") return { adminClient: () => admin };
      if (name === "@/lib/authorization.server") return {
        CAPABILITIES: caps,
        currentAuthorization: async () => ({ id: "grant", revokedAt: null }),
        sessionAuthorized: async (_admin, _id, cap) => {
          if (cap === undefined) { finalChecks++; return !revoked; }
          return new Promise((resolve, reject) => pending.set(cap, { resolve, reject }));
        },
      };
      throw Error(`Unexpected dependency: ${name}`);
    },
  });
  const request = new Request("https://example.invalid/authorization", {
    headers: { authorization: "Bearer synthetic-fixture-only" },
  });
  return {
    run: () => exports.Route.server.handlers.GET({ request, params: { sessionId: "session" } }),
    pending, revoke: () => { revoked = true; }, get finalChecks() { return finalChecks; },
  };
}

test("independent capabilities are checked concurrently, followed by revalidation", async () => {
  const f = fixture(), result = f.run();
  await flush();
  assert.deepEqual([...f.pending.keys()], caps);
  assert.equal(f.finalChecks, 1);
  for (const check of f.pending.values()) check.resolve(true);
  const response = await result, body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.allowed, true);
  assert.equal(body.capabilities.recording, true);
  assert.equal(f.finalChecks, 2);
});

test("revocation during capability lookup still denies every capability", async () => {
  const f = fixture(), result = f.run();
  await flush(); f.revoke();
  for (const check of f.pending.values()) check.resolve(true);
  const body = await (await result).json();
  assert.equal(body.allowed, false);
  assert.ok(Object.values(body.capabilities).every(value => value === false));
  assert.equal(body.authorizationId, null);
});

test("a failed capability check cannot return partial permission", async () => {
  const f = fixture(), result = f.run();
  await flush();
  f.pending.get("recording").reject(Error("synthetic lookup failure"));
  for (const [cap, check] of f.pending) if (cap !== "recording") check.resolve(true);
  assert.equal((await result).status, 503);
});
