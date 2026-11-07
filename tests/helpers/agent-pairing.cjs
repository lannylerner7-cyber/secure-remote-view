// Execute real route/auth modules with allow-listed in-memory dependencies only.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { load } = require("./agent-http.cjs");
const zod = createRequire(require("node:path").resolve("package.json"))("zod");
const sessionId = "11111111-1111-4111-8111-111111111111";
const grantId = "22222222-2222-4222-8222-222222222222";
const token = "PRIVATE_FIXTURE_TOKEN";
const grant = {
  id: grantId, noticeVersion: 1, mode: "unattended",
  capabilities: { view: true, control: true, clipboard: true, files: true, recording: false },
  recordedAt: "2026-01-01T00:00:00Z", revokedAt: null,
};
const routes = [
  ["hello", "POST", {}],
  ["authorization", "GET"],
  ["authorization", "POST", { noticeVersion: 1, mode: grant.mode, capabilities: grant.capabilities }],
  ["authorization.revoke", "POST", {}],
  ["beacon", "POST", { reason: "starting", authorizationId: grantId }],
  ["watch", "POST", { instance: sessionId, sequence: 1, authorization_id: grantId,
    agent_instance: null, startup_enabled: true, state: "running" }],
  ["stream", "GET"],
  ["release", "GET"],
  ["ice", "GET"],
  ["power.$cmdId.ack", "POST", { state: "delivered" }],
  ["session.$sessionId.consent", "POST", { decision: "accept", authorizationId: grantId, noticeVersion: 1 }],
  ["session.$sessionId.reconnect", "POST", {}],
  ["session.$sessionId.cursor", "POST", { x: 1, y: 2, w: 100, h: 100 }],
  ["session.$sessionId.inputs", "GET"],
  ["session.$sessionId.signal", "POST", { kind: "answer", payload: { sdp: "PRIVATE_SDP" } }],
  ["session.$sessionId.signal", "GET"],
  ["session.$sessionId.file", "POST", "PRIVATE_FILE_BYTES"],
];

function pairingRouteFixture([file, method, body]) {
  const f = {
    lookup: "ok", permission: "allowed", reads: [], writes: [], logs: [],
    subscriptions: 0, technicianChecks: 0, providerCalls: 0,
    device: { id: "PRIVATE_DEVICE_ROW", device_id: "PRIVATE_DEVICE_ID", platform: "windows",
      status: "online", metadata: { token_hash: crypto.createHash("sha256").update(token).digest("hex") } },
    session: { id: sessionId, device_id: "PRIVATE_DEVICE_ROW", technician_id: "PRIVATE_TECH",
      state: file.endsWith(".consent") ? "invited" : "active", mode: "control",
      consent_at: "2026-01-01T00:00:00Z", pairing_code: null, admin_client_id: null },
    grant: structuredClone(grant),
    inputs: [{ id: 1, kind: "mousemove", payload: { x: 1, y: 2 } },
      { id: 2, kind: "curtain_off", payload: {} }],
  };
  const privateError = { message: "PRIVATE_DATABASE_URL PRIVATE_TOKEN", code: "PRIVATE_CODE" };
  const result = (data, error = null) => ({ data, error });
  const admin = {
    async rpc(name, args) {
      f.reads.push({ rpc: name, args });
      if (f.permission === "network") throw new Error("PRIVATE_RPC_EXCEPTION");
      if (f.permission === "database") return result(true, privateError);
      if (name === "device_authorization") return result(f.grant);
      if (name === "session_authorized")
        return result(f.permission !== "denied" && f.grant.revokedAt === null &&
          f.session.state === "active" && f.grant.capabilities[args._capability]);
      assert.ok(["record_device_authorization", "revoke_device_authorization", "report_agent_watch"].includes(name));
      f.writes.push({ rpc: name });
      return result(name === "record_device_authorization" ? f.grant : { ok: true });
    },
    from(table) {
      let action = "select", value;
      const execute = async (single = false) => {
        f.reads.push({ table, action });
        if (action !== "select") {
          f.writes.push({ table, action, value });
          return result(table === "sessions" ? f.session : []);
        }
        if (table === "devices") {
          if (f.lookup === "network") throw new Error("PRIVATE_DEVICE_LOOKUP_EXCEPTION");
          if (f.lookup === "database") return result(f.device, privateError);
          return result(f.lookup === "missing" ? null : f.device);
        }
        if (table === "sessions") return result(f.session);
        if (table === "power_commands") return result({
          id: "PRIVATE_COMMAND", device_id: f.device.id, relay_device_id: null, kind: "wake", state: "dispatched",
        });
        if (table === "releases") return result({ product: "agent", version: "fixture", channel: "stable-update" });
        if (table === "user_roles") return result([{ role: "technician" }]);
        if (table === "session_inputs") return result(f.inputs);
        if (table === "session_signals") return result(single ? null : []);
        assert.fail(`Unexpected table: ${table}`);
      };
      const q = {
        select() { return q; }, eq() { return q; }, is() { return q; },
        gt() { return q; }, order() { return q; }, limit() { return q; }, or() { return q; },
        update(v) { action = "update"; value = v; return q; },
        insert(v) { action = "insert"; value = v; return q; },
        upsert(v) { action = "upsert"; value = v; return q; },
        maybeSingle: () => execute(true),
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return q;
    },
    storage: { from() { return {
      async upload() { f.writes.push({ storage: "upload" }); return result(null); },
    }; } },
  };
  const server = { adminClient() {
    if (f.lookup === "setup") throw Error("PRIVATE_CONFIG_EXCEPTION");
    return admin;
  } };
  const auth = load("lib/agent-auth.server.ts", { crypto, "./server-supabase": server });
  const modules = {
    "@tanstack/react-router": { createFileRoute: () => config => config },
    crypto, zod,
    "@/lib/agent-auth.server": auth,
    "@/lib/authorization.server": load("lib/authorization.server.ts"),
    "@/lib/server-supabase": server,
    "@/shared/platform": load("shared/platform.ts"),
    "@/lib/session-files.server": { BUCKET: "fixture-only" },
    "@/lib/agent-events.server": { listenForAgentEvents() {
      f.subscriptions++;
      return () => { f.subscriptions--; };
    } },
    "@supabase/supabase-js": { createClient() { return { auth: { async getUser() {
      f.technicianChecks++;
      return result({ user: { id: "PRIVATE_TECH" } });
    } } }; } },
  };
  const timers = new Set();
  const addTimer = () => { const timer = {}; timers.add(timer); return timer; };
  const globals = {
    URL, ReadableStream, TextEncoder, Uint8Array, Blob, AbortController,
    process: { env: { SUPABASE_URL: "https://fixture.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-key" } },
    console: Object.fromEntries(["info", "warn", "error", "log"].map(level => [level, (...v) => f.logs.push(v.join(" "))])),
    setTimeout: addTimer, setInterval: addTimer,
    clearTimeout: timer => timers.delete(timer), clearInterval: timer => timers.delete(timer),
    fetch() { f.providerCalls++; throw Error("Unexpected network access"); },
  };
  const handler = load(`routes/api/public/agent/${file}.ts`, modules, globals).Route.server.handlers[method];
  f.call = async (headers = { "x-device-id": f.device.device_id, "x-device-token": token }) => {
    const query = `?sessionId=${sessionId}&since=1&fileId=fixture&seq=0&channel=stable-update`;
    f.request = new Request(`https://fixture.invalid/api/public/agent/${file}${query}`, {
      method, headers,
      ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const response = await handler({ request: f.request, params: { sessionId, cmdId: "PRIVATE_COMMAND" } });
    if (response.headers.get("content-type") === "text/event-stream") await response.body.cancel();
    assert.equal(timers.size, 0, "no live stream/provider timers left by an isolated request");
    return response;
  };
  f.auth = auth;
  f.admin = admin;
  return f;
}

module.exports = { pairingRouteFixture, routes, token };
