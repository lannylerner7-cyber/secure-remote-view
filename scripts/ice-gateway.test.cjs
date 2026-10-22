// Isolated tests of the actual route; no provider, database, or app server needed.
// Run: node --test scripts/ice-gateway.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { test } = require("node:test");
const ts = require("typescript");

const compiled = ts.transpileModule(
  fs.readFileSync("src/routes/api/public/agent/ice.ts", "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  },
);
assert.deepEqual(compiled.diagnostics, []);

const relay = {
  urls: ["turn:relay.example.test:3478", "turns:relay.example.test:5349"],
  username: "synthetic-user",
  credential: "synthetic-credential",
};
const providerEnv = {
  CLOUDFLARE_CALLS_APP_ID: "synthetic-key-id",
  CLOUDFLARE_CALLS_APP_TOKEN: "synthetic-provider-token",
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const calls = [], logs = [], timers = new Map(), checkedTokens = [];
  let timerId = 0;
  const admin = {
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({ data: options.noSession ? null : {
          id: "00000000-0000-4000-8000-000000000001",
          state: options.state ?? "active",
          device_id: options.otherDevice ? "other" : "device-row",
          technician_id: options.otherOwner ? "other" : "synthetic-tech",
        }, error: options.dbError ? {} : null }),
        then(resolve) { return Promise.resolve({ data: (options.roles ?? ["technician"]).map(role => ({ role })), error: null }).then(resolve); },
      };
      return query;
    },
  };
  const modules = {
    "@tanstack/react-router": { createFileRoute: () => config => config },
    crypto,
    "@/lib/server-supabase": { adminClient: () => admin },
    "@/lib/authorization.server": { sessionAuthorized: async () => options.granted !== false },
    "@/lib/agent-auth.server": {
      verifyDevice: async () => options.device === false ? null : {
        admin, device: { id: "device-row", device_id: "synthetic-device" },
      },
    },
    "@supabase/supabase-js": {
      createClient: () => ({
        auth: { getUser: async token => {
          checkedTokens.push(token);
          return options.technician
            ? { data: { user: { id: "synthetic-tech" } }, error: null }
            : { data: { user: null }, error: { message: "invalid" } };
        } },
      }),
    },
  };
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports, Request, Response, AbortController, URL,
    process: { env: { ...providerEnv, ...options.env } },
    console: {
      warn: (...args) => logs.push(args.join(" ")),
      error: (...args) => logs.push(args.join(" ")),
      log: (...args) => logs.push(args.join(" ")),
    },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.ok(options.fetch, "unexpected provider call");
      return options.fetch(url, init, calls.length);
    },
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  return {
    calls, logs, timers, checkedTokens,
    get(signal, headers) {
      return exports.Route.server.handlers.GET({
        request: new Request("https://gateway.example.test/api/public/agent/ice" +
          (options.noSessionId ? "" : "?sessionId=00000000-0000-4000-8000-000000000001"), { signal, headers }),
      });
    },
    expire() {
      assert.equal(timers.size, 1);
      const [{ fn, ms }] = timers.values();
      assert.equal(ms, 5000, "one five-second provider budget");
      fn();
    },
  };
}

async function assertStunOnly(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.turn, false);
  assert.equal(body.ttlSeconds, 43200);
  assert.equal(body.iceServers.length, 1);
  assert.ok(body.iceServers[0].urls.every(url => url.startsWith("stun:")));
}

test("timeout bounds a stuck fetch even if the transport ignores AbortSignal", async () => {
  let resolveFetch;
  const h = harness({ fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const pending = h.get();
  await settle();
  h.expire();
  await assertStunOnly(await pending);
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.match(h.logs.join(" "), /timed out/);
  // Late completion must not trigger a second provider request or success log.
  resolveFetch(new Response(null, { status: 404 }));
  await settle();
  assert.equal(h.calls.length, 1);
});

test("session grant, active state, ownership and roles fail closed before mint", async () => {
  for (const options of [
    { noSessionId: true }, { noSession: true }, { state: "ended" },
    { granted: false }, { otherDevice: true }, { dbError: true },
    { device: false, technician: true, roles: ["viewer"] },
    { device: false, technician: true, roles: [], otherOwner: true },
    { device: false, technician: true, otherOwner: true },
  ]) {
    const h = harness({ ...options, env: { SUPABASE_URL: "https://example.test", SUPABASE_PUBLISHABLE_KEY: "synthetic" } });
    const res = await h.get(undefined, { authorization: "Bearer synthetic" });
    assert.ok([400, 403, 503].includes(res.status));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(h.calls.length, 0);
  }
});

test("super-admin may access an authorized active session owned by another technician", async () => {
  const h = harness({ device: false, technician: true, otherOwner: true, roles: ["super_admin"],
    env: { SUPABASE_URL: "https://example.test", SUPABASE_PUBLISHABLE_KEY: "synthetic" },
    fetch: async () => Response.json({ iceServers: relay }) });
  assert.equal((await h.get(undefined, { authorization: "Bearer synthetic" })).status, 200);
});

test("per-principal mint budget rejects repeated minting before provider call", async () => {
  const h = harness({ fetch: async () => Response.json({ iceServers: relay }) });
  for (let i = 0; i < 10; i++) assert.equal((await h.get()).status, 200);
  const blocked = await h.get();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal(h.calls.length, 10);
});

test("deadline includes stalled response-body parsing", async () => {
  const h = harness({ fetch: async () => ({
    ok: true, json: () => new Promise(() => {}),
  }) });
  const pending = h.get();
  await settle();
  h.expire();
  await assertStunOnly(await pending);
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test("legacy endpoint shares the original deadline", async () => {
  const h = harness({ fetch: async (_url, _init, n) =>
    n === 1 ? new Response(null, { status: 404 }) : new Promise(() => {}) });
  const pending = h.get();
  await settle();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].url, /credentials\/generate$/);
  h.expire();
  await assertStunOnly(await pending);
  assert.equal(h.calls[1].init.signal.aborted, true);
});

test("legacy endpoint can mint valid credentials after endpoint incompatibility", async () => {
  for (const status of [404, 405]) {
    const h = harness({ fetch: async (_url, _init, n) =>
      n === 1 ? new Response(null, { status }) : Response.json({ iceServers: relay }) });
    const body = await (await h.get()).json();
    assert.equal(body.turn, true);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].init.signal, h.calls[1].init.signal);
    assert.equal(h.timers.size, 0);
  }
});

test("caller cancellation aborts provider work and returns no credentials", async () => {
  const h = harness({
    env: { TURN_URLS: relay.urls[0], TURN_USERNAME: relay.username, TURN_PASSWORD: relay.credential },
    fetch: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const pending = h.get(controller.signal);
  await settle();
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(await response.text(), "");
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test("already cancelled requests never mint credentials", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await h.get(controller.signal)).status, 499);
  assert.equal(h.calls.length, 0);
});

test("provider errors fail safely without retries or raw-body/credential logging", async () => {
  for (const status of [401, 403, 429, 500]) {
    let cancelled = false;
    const h = harness({ fetch: async () => ({
      ok: false, status,
      body: { cancel: async () => { cancelled = true; } },
      text() { assert.fail("raw provider body must not be read"); },
    }) });
    await assertStunOnly(await h.get());
    assert.equal(h.calls.length, 1);
    assert.equal(cancelled, true);
    assert.match(h.logs.join(" "), new RegExp(`HTTP ${status}`));
    assert.ok(!h.logs.join(" ").includes(providerEnv.CLOUDFLARE_CALLS_APP_TOKEN));
    assert.equal(h.timers.size, 0);
  }
  const h = harness({ fetch: async () => { throw new Error(relay.credential); } });
  await assertStunOnly(await h.get());
  assert.ok(!h.logs.join(" ").includes(relay.credential));
});

test("supported provider ICE shapes preserve the native-client response envelope", async () => {
  for (const data of [
    { iceServers: relay },
    { iceServers: [relay] },
    [relay],
    { iceServers: { ...relay, urls: relay.urls[0] } },
  ]) {
    const h = harness({ fetch: async () => Response.json(data) });
    const response = await h.get();
    const body = await response.json();
    assert.equal(body.turn, true);
    assert.equal(body.ttlSeconds, 43200);
    assert.equal(body.iceServers.length, 2);
    assert.equal(body.iceServers[1].username, relay.username);
    assert.equal(body.iceServers[1].credential, relay.credential);
    assert.ok(Array.isArray(body.iceServers[1].urls));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(h.timers.size, 0);
    assert.equal(h.logs.length, 0);
    assert.equal(h.calls[0].init.redirect, "error");
  }
});

test("malformed JSON, malformed ICE, and STUN-only responses never claim TURN", async () => {
  for (const data of [
    null, {}, { iceServers: [] }, { iceServers: { urls: "stun:stun.example.test" } },
    { iceServers: { urls: relay.urls } },
    { iceServers: { ...relay, credential: 123 } },
    { iceServers: { ...relay, urls: [relay.urls[0], 123] } },
    { iceServers: { ...relay, urls: ["https://not-an-ice-server.test"] } },
  ]) {
    const h = harness({ fetch: async () => Response.json(data) });
    await assertStunOnly(await h.get());
  }
  const h = harness({ fetch: async () => new Response("not-json-synthetic-sensitive-body") });
  await assertStunOnly(await h.get());
  assert.ok(!h.logs.join(" ").includes("synthetic-sensitive-body"));
});

test("Cloudflare failure still permits configured coturn REST fallback", async () => {
  const h = harness({
    env: { TURN_URLS: relay.urls.join(","), TURN_STATIC_SECRET: "synthetic-secret" },
    fetch: async () => { throw new Error("unavailable"); },
  });
  const body = await (await h.get()).json();
  assert.equal(body.turn, true);
  const server = body.iceServers[1];
  assert.match(server.username, /^\d+:agent-device-row$/);
  assert.equal(server.credential,
    crypto.createHmac("sha1", "synthetic-secret").update(server.username).digest("base64"));
});

test("STUN-only coturn URLs cannot produce turn:true", async () => {
  const h = harness({
    env: {
      CLOUDFLARE_CALLS_APP_TOKEN: "",
      TURN_URLS: "stun:stun.example.test", TURN_USERNAME: relay.username, TURN_PASSWORD: relay.credential,
    },
  });
  await assertStunOnly(await h.get());
  assert.equal(h.calls.length, 0);
});

test("static coturn fallback preserves native credentials without provider configuration", async () => {
  const h = harness({
    env: {
      CLOUDFLARE_CALLS_APP_TOKEN: "",
      TURN_URLS: relay.urls.join(","), TURN_USERNAME: relay.username, TURN_PASSWORD: relay.credential,
    },
  });
  const body = await (await h.get()).json();
  assert.equal(body.turn, true);
  assert.deepEqual(body.iceServers[1], relay);
  assert.equal(h.calls.length, 0);
});

test("unauthorized requests cannot call the provider; technician bearer auth is preserved", async () => {
  const h = harness({ device: false });
  assert.equal((await h.get()).status, 401);
  assert.equal(h.calls.length, 0);

  const rejected = harness({
    device: false,
    env: { SUPABASE_URL: "https://supabase.example.test", SUPABASE_ANON_KEY: "synthetic-anon" },
  });
  assert.equal((await rejected.get(undefined, { authorization: "Bearer invalid-synthetic-jwt" })).status, 401);
  assert.equal(rejected.calls.length, 0);

  const tech = harness({
    device: false, technician: true,
    env: { SUPABASE_URL: "https://supabase.example.test", SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable" },
    fetch: async () => Response.json({ iceServers: relay }),
  });
  assert.equal((await (await tech.get(undefined, { authorization: "Bearer synthetic-jwt" })).json()).turn, true);
  assert.deepEqual(tech.checkedTokens, ["synthetic-jwt"]);
});
