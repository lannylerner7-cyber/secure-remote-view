const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./helpers/agent-http.cjs");
const { stubDeviceAuth } = require("./helpers/device-auth.cjs");

function fixture(options = {}) {
  const writes = [], reads = [];
  const session = { id: "session", device_id: "device", state: "active", admin_client_id: "current-controller", ...options.session };
  const signals = [
    { id: 10, session_id: "session", from_side: "admin", kind: "offer", admin_client_id: "current-controller", payload: {} },
    { id: 11, session_id: "session", from_side: "admin", kind: "ice", admin_client_id: "current-controller", payload: {} },
    { id: 30, session_id: "session", from_side: "admin", kind: "offer", admin_client_id: "retired-controller", payload: {} },
  ];
  const admin = { from(table) {
    let columns, single = false, ascending = true, limit = Infinity, insert;
    const predicates = [];
    const execute = () => {
      const stage = table === "sessions" ? "session" : columns === "id" ? "anchor" : insert ? "insert" : "signals";
      reads.push(stage);
      if (options.fail === stage) return { data: null, error: { message: "PRIVATE_DATABASE_ERROR" } };
      if (insert) { writes.push(insert); return { data: null, error: null }; }
      let rows = (table === "sessions" ? [session] : signals).filter(row => predicates.every(p => p(row)));
      rows = rows.sort((a, b) => ascending ? a.id - b.id : b.id - a.id).slice(0, limit);
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const q = {
      select(value) { columns = value; return q; },
      eq(key, value) { predicates.push(row => row[key] === value); return q; },
      gt(key, value) { predicates.push(row => row[key] > value); return q; },
      order(_key, options) { ascending = options.ascending; return q; },
      limit(value) { limit = value; return q; },
      or(value) {
        assert.equal(value, "admin_client_id.eq.current-controller,admin_client_id.is.null");
        predicates.push(row => row.admin_client_id == null || row.admin_client_id === "current-controller");
        return q;
      },
      insert(value) { insert = value; return q; },
      maybeSingle() { single = true; return Promise.resolve(execute()); },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    return q;
  } };
  const route = load("routes/api/public/agent/session.$sessionId.signal.ts", {
    "@tanstack/react-router": { createFileRoute: () => config => config },
    "@/lib/agent-auth.server": stubDeviceAuth(() => ({ admin, device: { id: "device" } })),
    "@/lib/authorization.server": { sessionAuthorized: async (_admin, _id, _cap, unavailable) => {
      if (options.authorizationUnavailable) { unavailable(); return false; }
      return options.allowed !== false;
    } },
  }, { URL });
  return { writes, reads, call(method = "GET", body = {}) {
    return route.Route.server.handlers[method]({
      params: { sessionId: "session" },
      request: new Request("https://fixture.invalid/api/public/agent/session/session/signal?since=0", {
        method,
        ...(method === "POST" ? { body: JSON.stringify({
          kind: "answer", payload: { peer_id: "synthetic-peer" }, admin_client_id: "current-controller", ...body,
        }), headers: { "content-type": "application/json" } } : {}),
      }),
    });
  } };
}

test("the current controller's offer is not skipped by a later stale-controller offer", async () => {
  const f = fixture(), response = await f.call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.items.map(item => item.id), [10, 11]);
  assert.equal(body.max, 11);
});

test("signaling lookup and authorization outages remain unavailable, not ended or revoked", async () => {
  for (const method of ["GET", "POST"]) for (const options of [
    { fail: "session" }, { authorizationUnavailable: true },
  ]) {
    const f = fixture(options), response = await f.call(method);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(f.writes.length, 0);
    assert.doesNotMatch(await response.text(), /PRIVATE/);
  }
});

test("an unavailable offer anchor cannot fall back to replaying old negotiations", async () => {
  const f = fixture({ fail: "anchor" }), response = await f.call();
  assert.equal(response.status, 503);
  assert.equal(f.reads.includes("signals"), false);
});

test("explicit denial, wrong devices, ended sessions and mismatched controllers remain blocked", async () => {
  assert.equal((await fixture({ allowed: false }).call()).status, 403);
  assert.equal((await fixture({ session: { device_id: "other-device" } }).call()).status, 404);
  assert.equal((await fixture({ session: { state: "ended" } }).call("POST")).status, 409);
  const f = fixture();
  assert.equal((await f.call("POST", { admin_client_id: "retired-controller" })).status, 409);
  assert.equal(f.writes.length, 0);
});
