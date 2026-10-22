/* Executes the actual browser wrapper with mocked browser/auth/signaling/HTTP.
 * No real credentials, networking, workflows or peer allocations are involved. */
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const assert = require("node:assert/strict");
const source = fs.readFileSync("src/lib/webrtc-live.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics.length, 0);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const secret = "synthetic-secret-must-not-be-logged";
const turn = (ttlSeconds = 100) => ({
  iceServers: [{ urls: "turn:relay.example:3478", username: secret, credential: secret }],
  ttlSeconds, turn: true,
});
const response = body => ({ ok: true, status: 200, json: async () => body });
function harness(options = {}) {
  let now = 1_000_000, next = 0, remote, removed = 0;
  const timers = new Map(), requests = [], signals = [], logs = [], peers = [];
  const timer = (fn, ms, interval = false) => {
    timers.set(++next, { fn, ms, at: now + ms, interval });
    return next;
  };
  const clock = {
    setTimeout: (fn, ms) => timer(fn, ms),
    setInterval: (fn, ms) => timer(fn, ms, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const channel = { on(_event, _filter, cb) { remote = cb; return this; }, subscribe() { return this; } };
  class Peer {
    constructor() { peers.push(this); this.iceConnectionState = "new"; this.configs = []; this.offers = []; this.locals = []; }
    createDataChannel() { return { readyState: "open", close() {}, send() {} }; }
    setConfiguration(config) {
      if (options.rejectConfig && config.iceServers.some(s => String(s.urls).startsWith("turn:"))) throw Error(secret);
      this.configs.push(config);
    }
    addTransceiver() { this.transceivers = (this.transceivers || 0) + 1; }
    createOffer(opts) { this.offers.push(opts); return options.offer?.() || Promise.resolve({ type: "offer", sdp: "synthetic-sdp" }); }
    setLocalDescription(offer) { this.locals.push(offer); return options.local?.() || Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    getStats() { return Promise.resolve(new Map()); }
    close() { this.closed = true; this.iceConnectionState = "closed"; this.oniceconnectionstatechange?.(); }
  }
  const dependencies = {
    "@/integrations/supabase/client": { supabase: {
      auth: { getSession: options.auth || (async () => ({ data: { session: { access_token: secret } } })) },
      channel: () => channel, removeChannel() { removed++; },
    } },
    "@/lib/webrtc-signal.functions": {
      bindAdmin: options.bind || (async () => ({ bound: true })),
      postAdminSignal: async ({ data }) => { signals.push(data); return options.signal?.(data) || { ok: true }; },
    },
    "@/shared/api-routes": { API_ROUTES: { agentIce: "/api/public/agent/ice" } },
    "@/lib/recording-authority": { RecordingAuthority: class { invalidate() {} } },
  };
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports, require: name => { assert.ok(dependencies[name], name); return dependencies[name]; },
    console: Object.fromEntries(["warn", "info", "debug", "error"].map(k => [k, (...args) => logs.push(args.join(" "))])),
    window: clock, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    Date: class extends Date { static now() { return now; } },
    AbortController, Blob, localStorage: storage, sessionStorage: storage,
    crypto: require("node:crypto").webcrypto, RTCPeerConnection: Peer,
    document: { createElement: () => ({ style: {} }) },
    fetch: (url, init) => {
      requests.push({ url, init });
      return options.fetch ? options.fetch(url, init, requests.length) : Promise.resolve(response(turn()));
    },
  });
  const live = exports.startWebRtcLive("session /?&");
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, t] = entry;
      now = t.at;
      if (t.interval) t.at += t.ms; else timers.delete(id);
      t.fn();
      await settle();
    }
    now = end;
    await settle();
  };
  return { live, requests, signals, logs, timers, peers, advance,
    get removed() { return removed; },
    remote: kind => remote({ new: { id: 1, from_side: "agent", kind, payload: {} } }),
    noSecrets() { assert.ok(!logs.join("\n").includes(secret)); },
  };
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }
test("session-scoped, authenticated no-store fetch precedes offer", async () => {
  const h = harness(); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/public/agent/ice?sessionId=session%20%2F%3F%26");
  assert.equal(h.requests[0].init.headers.authorization, `Bearer ${secret}`);
  assert.equal(h.requests[0].init.cache, "no-store");
  assert.equal(h.requests[0].init.redirect, "error");
  assert.equal(h.live.relay(), "relay");
  assert.equal(h.signals.filter(s => s.kind === "offer").length, 1);
  h.noSecrets(); h.live.close();
});
test("close during fetch aborts transport; ignored abort cannot produce late offer", async () => {
  const wait = deferred(), bye = deferred();
  const h = harness({ fetch: () => wait.promise, signal: s => s.kind === "bye" ? bye.promise : undefined });
  await settle(); h.live.close();
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.peers[0].closed, true, "teardown does not await bye");
  assert.equal(h.removed, 1);
  wait.resolve(response(turn())); await settle();
  assert.equal(h.peers[0].configs.length, 0);
  assert.equal(h.peers[0].offers.length, 0);
  assert.equal(h.timers.size, 0);
  h.noSecrets();
});
test("close during binding never fetches or installs heartbeat", async () => {
  const wait = deferred(), h = harness({ bind: () => wait.promise });
  h.live.close(); wait.resolve({ bound: true }); await settle();
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
});
test("binding denial or rejection cannot launch ICE", async () => {
  for (const bind of [async () => ({ bound: false, reason: "not_authorized" }), async () => { throw Error(secret); }]) {
    const h = harness({ bind }); await settle();
    assert.equal(h.requests.length, 0); assert.equal(h.live.state(), "failed");
    h.noSecrets(); h.live.close();
  }
});
test("stale createOffer completion after termination never applies or signals", async () => {
  const wait = deferred(), h = harness({ offer: () => wait.promise });
  await settle(); h.remote("terminated"); wait.resolve({ type: "offer", sdp: secret }); await settle();
  assert.equal(h.live.state(), "superseded");
  assert.equal(h.peers[0].locals.length, 0);
  assert.equal(h.signals.length, 0); h.noSecrets(); h.live.close();
});
test("stale setLocalDescription completion after close never signals", async () => {
  const wait = deferred(), h = harness({ local: () => wait.promise });
  await settle(); h.live.close(); wait.resolve(); await settle();
  assert.equal(h.signals.filter(s => s.kind === "offer").length, 0);
});
test("12s deadline covers slow HTTP; late success cannot override fallback", async () => {
  const wait = deferred(), h = harness({ fetch: () => wait.promise });
  await settle(); await h.advance(11_999);
  assert.equal(h.live.state(), "connecting"); assert.equal(h.peers[0].offers.length, 0);
  await h.advance(1);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.live.relay(), "none"); assert.equal(h.peers[0].offers.length, 1);
  wait.resolve(response(turn())); await settle();
  assert.equal(h.live.relay(), "none"); h.noSecrets(); h.live.close();
});
test("deadline also bounds auth and JSON parsing", async () => {
  for (const stage of ["auth", "body"]) {
    const wait = deferred();
    const h = harness(stage === "auth" ? { auth: () => wait.promise }
      : { fetch: async () => ({ ok: true, json: () => wait.promise }) });
    await settle(); await h.advance(12_000);
    assert.equal(h.live.relay(), "none");
    wait.resolve(stage === "auth" ? { data: { session: { access_token: secret } } } : turn());
    await settle();
    assert.equal(h.requests.length, stage === "auth" ? 0 : 1);
    assert.equal(h.live.relay(), "none"); h.live.close();
  }
});
test("server 5s provider budget plus auth/fallback can complete before browser deadline", async () => {
  const wait = deferred(), h = harness({ fetch: () => wait.promise });
  await settle(); await h.advance(6500);
  wait.resolve(response(turn())); await settle();
  assert.equal(h.live.relay(), "relay"); assert.equal(h.peers[0].offers.length, 1);
  h.live.close();
});
test("fallback retry is bounded and a restored TURN set triggers new gathering", async () => {
  const h = harness({ fetch: async (_url, _init, n) => response(n === 1 ? { iceServers: [{ urls: "stun:example" }] } : turn()) });
  await settle(); await h.advance(3000);
  assert.equal(h.requests.length, 2); assert.equal(h.live.relay(), "relay");
  assert.equal(h.peers[0].offers[1].iceRestart, true);
  assert.equal(h.signals.filter(s => s.kind === "offer").length, 2); h.live.close();
  const failed = harness({ fetch: async () => { throw Error(secret); } });
  await settle(); await failed.advance(9000);
  assert.equal(failed.requests.length, 2);
  assert.equal([...failed.timers.values()].filter(t => !t.interval && t.ms === 3000).length, 0);
  failed.noSecrets(); failed.live.close();
});
test("fallback retry receives full deadline rather than racing the offer watchdog", async () => {
  const wait = deferred();
  const h = harness({ fetch: async (_url, _init, n) => n === 1
    ? response({ iceServers: [{ urls: "stun:example" }] }) : wait.promise });
  await settle(); await h.advance(14_999);
  assert.equal(h.live.state(), "connecting");
  assert.equal(h.requests[1].init.signal.aborted, false);
  wait.resolve(response(turn())); await settle();
  assert.equal(h.live.relay(), "relay"); assert.equal(h.peers[0].offers.length, 2);
  h.live.close();
});
test("refresh before expiry; failed renewal removes old TURN, no endless retries", async () => {
  const h = harness({ fetch: async (_url, _init, n) => n === 1 ? response(turn(100)) : Promise.reject(Error(secret)) });
  await settle();
  h.peers[0].iceConnectionState = "connected"; h.peers[0].oniceconnectionstatechange();
  // Keep media moving by invoking only the expiry timeout, not the media watchdog.
  const expiry = [...h.timers].find(([, t]) => t.ms === 80_000);
  assert.ok(expiry);
  h.timers.delete(expiry[0]); expiry[1].fn(); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.live.relay(), "none");
  assert.ok(String(h.peers[0].configs.at(-1).iceServers[0].urls).startsWith("stun:"));
  const retry = [...h.timers].find(([, t]) => !t.interval && t.ms === 3000);
  h.timers.delete(retry[0]); retry[1].fn(); await settle();
  assert.equal(h.requests.length, 3);
  assert.equal([...h.timers.values()].filter(t => !t.interval).length, 0);
  h.noSecrets(); h.live.close();
});
test("actual media restart refreshes credentials before offer; close cancels refresh", async () => {
  for (const close of [false, true]) {
    const wait = deferred();
    const h = harness({ fetch: async (_url, _init, n) => n === 1 ? response(turn()) : wait.promise });
    await settle();
    h.peers[0].iceConnectionState = "connected"; h.peers[0].oniceconnectionstatechange();
    await h.advance(9000);
    assert.equal(h.requests.length, 2); assert.equal(h.peers[0].offers.length, 1);
    await h.advance(6000); assert.equal(h.live.state(), "connected", "media watchdog must not race pending refresh");
    if (close) h.live.close();
    wait.resolve(response(turn())); await settle();
    assert.equal(h.peers[0].offers.length, close ? 1 : 2);
    if (!close) assert.equal(h.peers[0].offers[1].iceRestart, true);
    h.noSecrets(); h.live.close();
  }
});
test("superseded expiry fetch cannot overwrite newer restart configuration", async () => {
  const old = deferred();
  const fresh = turn(); fresh.iceServers[0].urls = "turn:new.example:3478";
  const h = harness({ fetch: async (_url, _init, n) => n === 1 ? response(turn())
    : n === 2 ? old.promise : response(fresh) });
  await settle();
  h.peers[0].iceConnectionState = "connected"; h.peers[0].oniceconnectionstatechange();
  const expiry = [...h.timers].find(([, t]) => t.ms === 80_000);
  h.timers.delete(expiry[0]); expiry[1].fn(); await settle();
  await h.advance(9000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[1].init.signal.aborted, true);
  assert.equal(h.peers[0].configs.at(-1).iceServers[0].urls, "turn:new.example:3478");
  old.resolve(response(turn())); await settle();
  assert.equal(h.peers[0].configs.at(-1).iceServers[0].urls, "turn:new.example:3478");
  assert.equal(h.peers[0].offers.length, 2); h.noSecrets(); h.live.close();
});
test("denied grant stops startup without retry; 429 observes 60s cooldown", async () => {
  for (const status of [400, 401, 403, 404]) {
    const h = harness({ fetch: async () => ({ ok: false, status }) });
    await settle(); assert.equal(h.live.state(), "failed");
    assert.equal(h.peers[0].offers.length, 0);
    assert.equal([...h.timers.values()].filter(t => !t.interval).length, 0);
    h.live.close();
  }
  const h = harness({ fetch: async () => ({ ok: false, status: 429 }) });
  await settle();
  assert.ok([...h.timers.values()].some(t => !t.interval && t.ms === 60_000));
  h.live.close();
});
test("rejected TURN configuration reports direct-only and never logs secret errors", async () => {
  const h = harness({ rejectConfig: true }); await settle();
  assert.equal(h.live.relay(), "none"); assert.equal(h.peers[0].offers.length, 1);
  h.noSecrets(); h.live.close();
});
test("watchdog failure invalidates a pending local-description completion", async () => {
  const wait = deferred(), h = harness({ local: () => wait.promise });
  await settle();
  h.peers[0].iceConnectionState = "checking"; h.peers[0].oniceconnectionstatechange();
  await h.advance(10_000);
  assert.equal(h.live.state(), "failed");
  wait.resolve(); await settle();
  assert.equal(h.signals.filter(s => s.kind === "offer").length, 0);
  h.live.close();
});
(async () => {
  for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
  console.log(`${tests.length} actual browser ICE hardening scenarios passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
