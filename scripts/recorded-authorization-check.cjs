// Isolated tests of actual imported handlers. No network, secrets or database.
// The SQL authority RPC is an explicit in-memory substitute, NOT PostgreSQL verification.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const ts = require("typescript");
const root = "src/";
function load(file, modules = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(root + file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, Request, Response, URL, Date, console, Uint8Array, Blob,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency ${name}`);
      return modules[name];
    },
  });
  return exports;
}
const authority = load("lib/authorization.server.ts");
const grantId = "11111111-1111-4111-8111-111111111111";
const requestGrant = (overrides = {}) => ({
  noticeVersion: 1, mode: "attended",
  capabilities: { view: true, control: false, clipboard: false, files: false, recording: false, ...overrides },
});
function fixture() {
  const f = {
    grant: null, unauthorized: false, rpcError: false, raced: false, writes: [],
    userId: "tech", superAdmin: false,
    session: { id: "session", device_id: "device", technician_id: "tech",
      state: "invited", mode: "view", consent_at: "legacy-timestamp",
      authorization_id: null, authorization_mode: null },
    inputs: [], filters: [],
  };
  f.authorize = (caps = {}) => {
    f.grant = { ...requestGrant(caps), id: grantId,
      recordedAt: "2026-10-21T00:00:00.000Z", revokedAt: null };
    Object.assign(f.session, { state: "active", authorization_id: grantId, authorization_mode: f.grant.mode });
  };
  f.admin = {
    auth: { getUser: async () => ({ data: { user: f.unauthorized ? null : { id: f.userId } }, error: null }) },
    async rpc(name, args) {
      if (f.rpcError) return { data: null, error: { message: "missing RPC" } };
      if (name === "has_role") return { data: f.superAdmin, error: null };
      if (name === "device_authorization") return { data: f.grant, error: null };
      if (name === "record_device_authorization") {
        f.session.state = "ended";
        f.grant = { ...args._grant, id: grantId, recordedAt: "2026-10-21T00:00:00.000Z", revokedAt: null };
        return { data: f.grant, error: null };
      }
      if (name === "revoke_device_authorization") {
        if (f.grant) f.grant.revokedAt = "2026-10-21T01:00:00.000Z";
        f.session.state = "ended";
        return { data: null, error: null };
      }
      assert.equal(name, "session_authorized");
      const s = f.session, g = f.grant, cap = args._capability;
      const allowed = !!g && g.noticeVersion === 1 && g.revokedAt === null &&
        s.state === "active" && s.device_id === "device" &&
        s.authorization_id === g.id && s.authorization_mode === g.mode &&
        !!g.capabilities.view && !!g.capabilities[cap] &&
        ["view", "control"].includes(s.mode) &&
        (s.mode !== "control" || g.capabilities.control) &&
        (cap !== "control" || s.mode === "control");
      return { data: allowed, error: null };
    },
    from(table) {
      let update, eqs = [];
      const q = {
        select() { return q; }, gt() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { eqs.push([k,v]); return q; },
        update(value) { update = value; return q; },
        insert(value) { f.writes.push({ table, value }); return Promise.resolve({ error: null }); },
        upsert(value) { f.writes.push({ table, value }); return Promise.resolve({ error: null }); },
        async maybeSingle() {
          if (!update) return { data: f.session, error: null };
          f.filters.push(...eqs);
          if (f.raced || eqs.some(([key,val]) => f.session[key] !== val)) return { data: null, error: null };
          f.writes.push({ table, value: update });
          Object.assign(f.session, update);
          return { data: f.session, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({ data: table === "session_inputs" ? f.inputs : [], error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  f.call = async (route, method = "POST", body, query = "") => {
    const mod = load("routes/api/public/" + route + ".ts", {
      "@tanstack/react-router": { createFileRoute: () => config => config },
      "@/lib/agent-auth.server": { verifyDevice: async () => f.unauthorized ? null : { admin: f.admin, device: { id: "device" } } },
      "@/lib/authorization.server": authority,
      "@/lib/server-supabase": { adminClient: () => f.admin },
      "@/lib/session-files.server": { BUCKET: "session-files" },
    });
    return mod.Route.server.handlers[method]({
      request: new Request("https://isolated.invalid/" + route + query, {
        method, headers: { authorization: "Bearer isolated-test-identity" },
        ...(method !== "GET" ? { body: body === undefined ? "" : JSON.stringify(body) } : {}),
      }),
      params: { sessionId: "session" },
    });
  };
  return f;
}
const sessionRoute = name => `agent/session.$sessionId.${name}`;
let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log("PASS", name);
}
(async () => {
  await test("strict request rejects unknown/missing/version/control-without-view", () => {
    assert.ok(authority.parseGrantRequest(requestGrant()));
    for (const value of [null, {}, { ...requestGrant(), extra: true }, { ...requestGrant(), noticeVersion: 2 },
      { ...requestGrant(), capabilities: { view: true } }, requestGrant({ view: false, control: true }),
      requestGrant({ invented: true })]) assert.equal(authority.parseGrantRequest(value), null);
  });
  await test("legacy timestamp does not authorize view, cursor, signal or reconnect", async () => {
    const f = fixture(); f.session.state = "active";
    for (const [name, body] of [["frame", { frame: "jpeg" }], ["cursor", {}], ["signal", { kind: "offer", payload: {} }], ["reconnect", {}]]) {
      const r = await f.call(sessionRoute(name), "POST", body);
      assert.notEqual(r.status, 200, name);
    }
    assert.equal(f.writes.length, 0);
  });
  await test("device auth required to GET/POST grant and revoke", async () => {
    const f = fixture(); f.unauthorized = true;
    for (const [route, method] of [["agent/authorization", "GET"], ["agent/authorization", "POST"], ["agent/authorization.revoke", "POST"]])
      assert.equal((await f.call(route, method, requestGrant())).status, 401);
  });
  await test("GET missing authority returns null; POST records strict wire response", async () => {
    const f = fixture();
    assert.equal((await (await f.call("agent/authorization", "GET")).json()).authorization, null);
    assert.equal((await f.call("agent/authorization", "POST", { ...requestGrant(), noticeVersion: 2 })).status, 400);
    const r = await f.call("agent/authorization", "POST", requestGrant());
    assert.equal(r.status, 200);
    assert.equal((await r.json()).authorization.id, grantId);
  });
  await test("correct consent binds grant while preserving atomic invited comparison", async () => {
    const f = fixture(); f.authorize(); f.session.state = "invited";
    const r = await f.call(sessionRoute("consent"), "POST", { decision: "accept", authorizationId: grantId, noticeVersion: 1 });
    assert.equal(r.status, 200); assert.equal(f.session.authorization_id, grantId);
    assert.ok(f.filters.some(([k,v]) => k === "state" && v === "invited"));
  });
  await test("wrong/missing grant, version and revoked consent denied", async () => {
    for (const body of [{ decision: "accept" }, { decision: "accept", authorizationId: "wrong", noticeVersion: 1 },
      { decision: "accept", authorizationId: grantId, noticeVersion: 2 }]) {
      const f = fixture(); f.authorize(); f.session.state = "invited";
      assert.equal((await f.call(sessionRoute("consent"), "POST", body)).status, 403);
      assert.equal(f.writes.length, 0);
    }
    const f = fixture(); f.authorize(); f.session.state = "invited"; f.grant.revokedAt = "2026-10-21T01:00:00Z";
    assert.equal((await f.call(sessionRoute("consent"), "POST", { decision: "accept", authorizationId: grantId, noticeVersion: 1 })).status, 403);
  });
  await test("raced invitation never audits acceptance", async () => {
    const f = fixture(); f.authorize(); f.session.state = "invited"; f.raced = true;
    assert.equal((await f.call(sessionRoute("consent"), "POST", { decision: "accept", authorizationId: grantId, noticeVersion: 1 })).status, 409);
    assert.equal(f.writes.length, 0);
  });
  await test("view grant permits frame/cursor, forbids control and file transfer", async () => {
    const f = fixture(); f.authorize();
    assert.equal((await f.call(sessionRoute("frame"), "POST", { frame: "jpeg" })).status, 200);
    assert.equal((await f.call(sessionRoute("cursor"), "POST", {})).status, 200);
    assert.equal(await authority.sessionAuthorized(f.admin, "session", "control"), false);
    assert.equal((await f.call(sessionRoute("file"), "POST", undefined, "?fileId=test&seq=0")).status, 409);
  });
  await test("control/files separate; control scope alone in view mode gives no input", async () => {
    const f = fixture(); f.authorize({ control: true, files: true });
    f.inputs = ["mousemove", "clipboard", "release_inputs", "unrecognized"].map((kind, i) => ({ id:i+1, kind, payload:{} }));
    let body = await (await f.call(sessionRoute("inputs"), "GET")).json();
    assert.deepEqual(body.items.map(r => r.kind), ["release_inputs"]);
    f.session.mode = "control";
    body = await (await f.call(sessionRoute("inputs"), "GET")).json();
    assert.deepEqual(body.items.map(r => r.kind), ["mousemove", "release_inputs"]);
    assert.equal(await authority.sessionAuthorized(f.admin, "session", "files"), true);
  });
  await test("wrong session grant never grants authority", async () => {
    const f = fixture(); f.authorize(); f.session.authorization_id = "wrong";
    assert.equal((await f.call(sessionRoute("frame"), "POST", { frame: "jpeg" })).status, 409);
  });
  await test("file route permits scoped empty chunk and rejects wrong grant", async () => {
    const f = fixture(); f.authorize({ files: true });
    assert.equal((await f.call(sessionRoute("file"), "POST", undefined, "?fileId=test&seq=0")).status, 200);
    f.session.authorization_id = "wrong";
    assert.equal((await f.call(sessionRoute("file"), "POST", undefined, "?fileId=test&seq=0")).status, 409);
  });
  await test("unknown authority version and malformed record fail closed", async () => {
    const f = fixture(); f.authorize(); f.grant.noticeVersion = 2;
    assert.equal((await f.call("agent/authorization", "GET")).status, 503);
    assert.equal((await f.call(sessionRoute("frame"), "POST", { frame: "jpeg" })).status, 409);
    f.grant.noticeVersion = 1; f.grant.capabilities.view = "true";
    assert.equal((await f.call("agent/authorization", "GET")).status, 503);
  });
  await test("revoke idempotent; ended state cannot reconnect; safety still delivered", async () => {
    const f = fixture(); f.authorize({ control: true }); f.session.mode = "control";
    assert.equal((await f.call("agent/authorization.revoke")).status, 200);
    assert.equal((await f.call("agent/authorization.revoke")).status, 200);
    assert.equal(f.session.state, "ended");
    assert.equal((await f.call(sessionRoute("reconnect"), "POST", {})).status, 409);
    f.inputs = [{ id:1, kind:"mousemove", payload:{} }, { id:2, kind:"release_inputs", payload:{} }];
    const body = await (await f.call(sessionRoute("inputs"), "GET")).json();
    assert.deepEqual(body.items.map(r => r.kind), ["release_inputs"]);
  });
  await test("revoked grant denies even a stale active session", async () => {
    const f = fixture(); f.authorize(); f.grant.revokedAt = "2026-10-21T01:00:00Z";
    assert.equal((await f.call(sessionRoute("frame"), "POST", { frame: "jpeg" })).status, 409);
  });
  await test("missing migration denies channels and returns explicit grant error", async () => {
    const f = fixture(); f.authorize(); f.rpcError = true;
    assert.equal((await f.call("agent/authorization", "GET")).status, 503);
    assert.equal((await f.call(sessionRoute("frame"), "POST", { frame: "jpeg" })).status, 409);
  });
  const adminRoute = "admin/session.$sessionId.authorization";
  await test("admin authorization endpoint returns only owner-scoped capability response", async () => {
    const f = fixture(); f.authorize({ recording: true });
    const r = await f.call(adminRoute, "GET"), body = await r.json();
    assert.equal(r.status, 200); assert.equal(body.allowed, true);
    assert.equal(body.capabilities.recording, true); assert.equal(body.capabilities.control, false);
    assert.deepEqual(Object.keys(body).sort(), ["allowed", "authorizationId", "capabilities"]);
    assert.equal(body.authorizationId, grantId);
  });
  await test("admin authorization rejects unrelated user, accepts confirmed super-admin", async () => {
    const f = fixture(); f.authorize(); f.userId = "unrelated";
    assert.equal((await f.call(adminRoute, "GET")).status, 403);
    f.superAdmin = true; assert.equal((await f.call(adminRoute, "GET")).status, 200);
    f.unauthorized = true; assert.equal((await f.call(adminRoute, "GET")).status, 401);
  });
  await test("admin endpoint revoked/ended sessions return all false, no id", async () => {
    for (const state of ["ended", "paused", "invited"]) {
      const f = fixture(); f.authorize({ recording: true }); f.session.state = state;
      const body = await (await f.call(adminRoute, "GET")).json();
      assert.equal(body.allowed, false); assert.equal(body.authorizationId, null);
      assert.ok(Object.values(body.capabilities).every(v => v === false));
    }
    const f = fixture(); f.authorize(); f.grant.revokedAt = "2026-10-21T01:00:00Z";
    const body = await (await f.call(adminRoute, "GET")).json();
    assert.equal(body.allowed, false); assert.equal(body.authorizationId, null);
  });
  console.log(`${passed} isolated handler checks passed. SQL RPC behavior was substituted; no PostgreSQL/RLS verification.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
