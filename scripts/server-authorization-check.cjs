// Exercise actual handlers/helpers with isolated substitutes, not a live database.
// RPC authorization is explicitly modeled here; this does not execute SQL/RLS.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const ts = require("typescript");

function load(file, modules) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, Request, Response, Date, console,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  return exports;
}
const authorization = load("src/lib/authorization.server.ts", {});
const grantId = "11111111-1111-4111-8111-111111111111";
const recordedGrant = () => ({
  id: grantId, noticeVersion: 1, mode: "attended",
  capabilities: { view: true, control: true, clipboard: false, files: false, recording: false },
  recordedAt: "2026-10-21T00:00:00Z", revokedAt: null,
});
let checked = 0;
async function test(name, fn) {
  await fn();
  console.log("PASS:", name);
  checked++;
}

async function reconnect(options = {}) {
  const writes = [];
  const filters = [];
  const session = {
    id: "session-1", device_id: "device-1", state: "active", mode: "control",
    consent_at: "2026-10-21T00:00:00Z", pairing_code: "123456",
    authorization_id: grantId, authorization_mode: "attended",
    ...options.session,
  };
  const grant = options.noGrant ? null : { ...recordedGrant(), ...options.grant };
  const admin = {
    rpc: async (name, args) => {
      assert.equal(name, "session_authorized");
      assert.equal(args._session_id, session.id);
      assert.equal(args._capability, "view");
      if (options.authorityError) return { data: null, error: {} };
      return {
        data: !!grant && grant.noticeVersion === 1 && grant.revokedAt === null &&
          session.state === "active" && !!session.consent_at &&
          session.authorization_id === grant.id && session.authorization_mode === grant.mode &&
          grant.capabilities.view === true &&
          (session.mode === "view" || (session.mode === "control" && grant.capabilities.control === true)),
        error: null,
      };
    },
    from(table) {
      let isUpdate = false;
      const q = {
        select() { return q; },
        eq(key, val) { if (isUpdate) filters.push([key, val]); return q; },
        update(value) { isUpdate = true; writes.push({ table, value }); return q; },
        insert(value) { writes.push({ table, value }); return Promise.resolve({ error: null }); },
        maybeSingle() {
          return Promise.resolve({
            data: isUpdate ? (options.raced ? null : session) : (options.missing ? null : session),
            error: options.dbError ? { message: "private db error" } : null,
          });
        },
      };
      return q;
    },
  };
  const mod = load("src/routes/api/public/agent/session.$sessionId.reconnect.ts", {
    "@tanstack/react-router": { createFileRoute: () => config => config },
    "@/lib/agent-auth.server": { verifyDevice: async () =>
      options.unauthorized ? null : { admin, device: { id: "device-1" } } },
    "@/lib/authorization.server": authorization,
  });
  const response = await mod.Route.server.handlers.POST({
    request: new Request("https://invalid.test/reconnect", {
      method: "POST", body: JSON.stringify(options.body === undefined ? {} : options.body),
    }),
    params: { sessionId: "session-1" },
  });
  return { response, writes, filters };
}

const serverFunctions = load("src/lib/webrtc-signal.functions.ts", {
  "@tanstack/react-start": {
    createServerFn: () => {
      let validate;
      const chain = {
        middleware: () => chain,
        inputValidator(fn) { validate = fn; return chain; },
        handler(fn) { return arg => fn({ ...arg, data: validate(arg.data) }); },
      };
      return chain;
    },
  },
  "@/integrations/supabase/auth-middleware": { requireSupabaseAuth: {} },
  "./authorization.server": authorization,
});
async function binding({
  owner = "owner", actor = "other", superRole = false, roleError = null,
  missing = false, authorized = true, authorityError = null,
} = {}) {
  let bindings = 0;
  const query = {
    select() { return query; }, eq() { return query; },
    maybeSingle: async () => ({ data: missing ? null : { technician_id: owner }, error: null }),
  };
  const supabase = {
    from: () => query,
    rpc: async (name, args) => {
      if (name === "has_role") return { data: superRole, error: roleError };
      if (name === "session_authorized") {
        assert.equal(args._session_id, "session-123");
        assert.equal(args._capability, "view");
        return { data: authorized, error: authorityError };
      }
      assert.equal(name, "bind_admin");
      bindings++;
      return { data: [{ bound: true, reason: "ok", admin_client_id: "client-123" }], error: null };
    },
  };
  const result = await serverFunctions.bindAdmin({
    data: { sessionId: "session-123", clientId: "client-123" },
    context: { userId: actor, supabase },
  });
  return { result, bindings };
}

(async () => {
  for (const state of ["invited", "consented", "paused", "declined", "ended", "unexpected"]) {
    await test(`reconnect rejects ${state} without writes`, async () => {
      const result = await reconnect({ session: { state } });
      assert.equal(result.response.status, 409);
      assert.equal(result.writes.length, 0);
    });
  }
  await test("active without consent is rejected", async () => {
    const r = await reconnect({ session: { consent_at: null } });
    assert.equal(r.response.status, 409); assert.equal(r.writes.length, 0);
  });
  for (const [name, options] of [
    ["legacy timestamp without grant", { noGrant: true }],
    ["wrong grant binding", { session: { authorization_id: "wrong" } }],
    ["wrong access mode binding", { session: { authorization_mode: "unattended" } }],
    ["revoked grant", { grant: { revokedAt: "2026-10-21T01:00:00Z" } }],
    ["unknown notice version", { grant: { noticeVersion: 2 } }],
    ["missing authority RPC", { authorityError: true }],
  ]) await test(`active reconnect rejects ${name}`, async () => {
    const r = await reconnect(options);
    assert.equal(r.response.status, 409);
    assert.equal(r.writes.length, 0);
  });
  for (const [name, options, status] of [
    ["unauthenticated", { unauthorized: true }, 401],
    ["wrong device", { session: { device_id: "other" } }, 403],
    ["missing session", { missing: true }, 404],
    ["wrong code", { body: { code: "654321" } }, 403],
    ["invalid body", { body: null }, 400],
    ["invalid code type", { body: { code: 123456 } }, 400],
  ]) await test(`reconnect rejects ${name}`, async () => {
    const r = await reconnect(options);
    assert.equal(r.response.status, status); assert.equal(r.writes.length, 0);
  });
  await test("active reconnect cannot change state/mode and uses conditional filters", async () => {
    const r = await reconnect();
    assert.equal(r.response.status, 200);
    const update = r.writes.find(w => w.table === "sessions").value;
    assert.deepEqual(Object.keys(update), ["updated_at"]);
    for (const key of ["device_id", "state", "consent_at", "mode"])
      assert.ok(r.filters.some(([k]) => k === key));
    assert.equal((await r.response.json()).mode, "control");
  });
  await test("raced session update returns conflict, no follow-on writes", async () => {
    const r = await reconnect({ raced: true });
    assert.equal(r.response.status, 409);
    assert.equal(r.writes.length, 1);
  });
  for (const [name, options, permitted] of [
    ["owner", { actor: "owner" }, true],
    ["super administrator", { superRole: true }, true],
    ["unrelated user", {}, false],
    ["role lookup error", { superRole: true, roleError: {} }, false],
    ["missing session", { missing: true }, false],
    ["owner without active grant", { actor: "owner", authorized: false }, false],
    ["super-admin without active grant", { superRole: true, authorized: false }, false],
    ["owner authority RPC error", { actor: "owner", authorityError: {} }, false],
  ]) await test(`binding ${name}`, async () => {
    const r = await binding(options);
    assert.equal(r.result.bound, permitted);
    assert.equal(r.bindings, permitted ? 1 : 0);
  });
  for (const scenario of [
    { name: "invalid consent payload", body: null, expected: 400 },
    { name: "unknown consent decision", body: { decision: "yes" }, expected: 400 },
    { name: "raced consent write", raced: true, expected: 409 },
    { name: "failed consent write", failed: true, expected: 500 },
    { name: "accepted consent write", expected: 200 },
    { name: "wrong grant consent", body: { decision: "accept", authorizationId: "wrong", noticeVersion: 1 }, expected: 403 },
    { name: "legacy consent without grant binding", body: { decision: "accept" }, expected: 403 },
    { name: "wrong notice version consent", body: { decision: "accept", authorizationId: grantId, noticeVersion: 2 }, expected: 403 },
    { name: "missing recorded grant consent", noGrant: true, expected: 403 },
    { name: "revoked recorded grant consent", grant: { revokedAt: "2026-10-21T01:00:00Z" }, expected: 403 },
    { name: "authority RPC failure consent", authorityError: true, expected: 503 },
    { name: "non-invited consent", state: "active", expected: 409 },
    { name: "missing device session consent", missing: true, expected: 404 },
    { name: "unauthenticated consent", unauthorized: true, expected: 401 },
    { name: "decline allowed without grant", noGrant: true, body: { decision: "decline" }, expected: 200 },
  ]) await test(scenario.name, async () => {
    let writes = 0, audits = 0;
    const conditions = [];
    const updates = [];
    const grant = scenario.noGrant ? null : { ...recordedGrant(), ...scenario.grant };
    const admin = {
      rpc: async (name, args) => {
        assert.equal(name, "device_authorization");
        assert.equal(args._device_id, "device-1");
        return { data: grant, error: scenario.authorityError ? {} : null };
      },
      from(table) {
        let updating = false;
        const q = {
          select() { return q; },
          eq(key, value) { conditions.push([key, value]); return q; },
          update(value) { writes++; updates.push(value); updating = true; return q; },
          insert() { audits++; return Promise.resolve({ error: null }); },
          maybeSingle: async () => ({
            data: updating
              ? (scenario.raced || scenario.failed ? null : { id: "session-1" })
              : (scenario.missing ? null : { id: "session-1", state: scenario.state ?? "invited", mode: "view" }),
            error: updating && scenario.failed ? {} : null,
          }),
        };
        return q;
      },
    };
    const mod = load("src/routes/api/public/agent/session.$sessionId.consent.ts", {
      "@tanstack/react-router": { createFileRoute: () => config => config },
      "@/lib/agent-auth.server": {
        verifyDevice: async () => scenario.unauthorized ? null : ({ admin, device: { id: "device-1" } }),
      },
      "@/lib/authorization.server": authorization,
    });
    const response = await mod.Route.server.handlers.POST({
      request: new Request("https://invalid.test/consent", {
        method: "POST", body: JSON.stringify(Object.hasOwn(scenario, "body") ? scenario.body
          : { decision: "accept", authorizationId: grantId, noticeVersion: 1 }),
      }), params: { sessionId: "session-1" },
    });
    assert.equal(response.status, scenario.expected);
    assert.equal(audits, scenario.expected === 200 ? 1 : 0);
    if (scenario.expected === 200 || scenario.raced || scenario.failed) {
      assert.equal(writes, 1);
      assert.ok(conditions.some(([k, v]) => k === "state" && v === "invited"));
      assert.ok(conditions.some(([k, v]) => k === "device_id" && v === "device-1"));
      const declined = scenario.body?.decision === "decline";
      assert.equal(updates[0].authorization_id, declined ? null : grantId);
      assert.equal(updates[0].authorization_mode, declined ? null : "attended");
    } else assert.equal(writes, 0);
    if (scenario.expected !== 400 && scenario.expected !== 401)
      assert.ok(conditions.some(([k, v]) => k === "device_id" && v === "device-1"));
  });
  console.log(`${checked} server authorization checks passed (mocked database/RPC; SQL/RLS not executed).`);
})().catch(e => { console.error(e); process.exitCode = 1; });
