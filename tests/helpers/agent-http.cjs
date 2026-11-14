// No environment, network or database access. Execute the actual TS modules.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const ts = require("typescript");
const root = "src/";

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(root + file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, Request, Response, Date,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected import: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return exports;
}

function diagnosticsFixture() {
  let now = 0;
  const logs = [], timers = new Map();
  const clock = {
    setTimeout(fn, delay) {
      const id = { unref() {} };
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  };
  const modules = load("lib/agent-http-diagnostics.server.ts", {
    "node:crypto": crypto,
    "./live-diagnostics": load("lib/live-diagnostics.ts"),
  }, {
    performance: { now: () => now },
    console: { info: line => logs.push(JSON.parse(line)), warn: line => logs.push(JSON.parse(line)) },
    ...clock,
  });
  return {
    modules, logs, timers, clock,
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.due <= now) {
        timers.delete(id); timer.fn();
      }
    },
  };
}

function routeFixture(operation, options = {}) {
  const diagnostics = diagnosticsFixture();
  const writes = [], reads = [], telemetrySignals = [];
  const grant = {
    id: "11111111-1111-4111-8111-111111111111",
    noticeVersion: 1, mode: "unattended",
    capabilities: { view: true, control: false, files: false, clipboard: false, recording: false },
    recordedAt: "2026-01-01T00:00:00Z", revokedAt: null, ...options.grant,
  };
  const session = {
    id: "fixture-session", device_id: "fixture-device", mode: "view",
    state: "active", media_mode: "legacy", created_at: "2026-01-01T00:00:00Z", ...options.session,
  };
  const device = {
    id: "fixture-device", device_id: "fixture-public-id",
    status: "online", last_seen_at: new Date().toISOString(), license_id: "fixture-license",
    license_state: "active",
    metadata: { token_hash: crypto.createHash("sha256").update("fixture-token").digest("hex") },
    ...options.device,
  };
  const license = { id: "fixture-license", meeting_id: "PRIVATE_MEETING", seat_limit: 5,
    status: "active", starts_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" };
  const errorFor = stage => options.fail === stage
    ? { message: "PRIVATE_DATABASE_ERROR PRIVATE_FRAME PRIVATE_TOKEN", code: "PRIVATE_CODE" } : null;
  const admin = {
    async rpc(name) {
      diagnostics.advance(2);
      const stage = { device_authorization: "authorization", session_authorized: "session_authorization",
        record_agent_runtime: "runtime_write" }[name];
      assert.ok(stage, `unexpected RPC: ${name}`);
      reads.push(stage);
      if (options.throwAt === stage) throw Error("PRIVATE_DATABASE_EXCEPTION");
      return { error: errorFor(stage), data: name === "device_authorization" ? grant :
        name === "session_authorized" ? options.allowed !== false : options.recorded !== false };
    },
    from(table) {
      let action = "select", values, columns;
      const filters = [];
      const execute = async () => {
        diagnostics.advance(2);
        const stage = table === "devices"
          ? action === "select" ? "device_auth" : values.license_state ? "license_state_write" : "presence_write"
          : { sessions: action === "select" ? (columns === "id, state, authorization_id" ? "session_status_lookup" : "sessions_lookup") : "session_cleanup",
              session_frames: "frame_write", licenses: "license_lookup",
              power_commands: action === "select" ? "commands_lookup" : "commands_dispatch",
              notifications: "notification_write" }[table];
        reads.push(stage);
        if (action !== "select") writes.push({ table, action, values, filters });
        if (options.throwAt === stage) throw Error("PRIVATE_DATABASE_EXCEPTION");
        if (options.stall === stage) return new Promise(() => {});
        let data = null;
        if (table === "devices" && action === "select")
          data = columns === "*" ? device : [{ id: device.id }];
        if (table === "sessions" && action === "select")
          data = operation === "frame" ? session : [session];
        if (stage === "session_status_lookup") {
          const row = options.statusRecord ?? { ...session, authorization_id: grant.id };
          data = filters.every(([key, value]) => row[key] === value) ? row : null;
        }
        if (table === "licenses") data = license;
        if (table === "power_commands") data = [];
        return { data, error: errorFor(stage) };
      };
      const query = {
        select(value) { columns = value; return query; },
        update(value) { action = "update"; values = value; return query; },
        upsert(value) { action = "upsert"; values = value; return query; },
        insert(value) { action = "insert"; values = value; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        in(key, value) { filters.push([key, value]); return query; },
        order() { return query; }, or() { return query; }, gt() { return query; }, limit() { return query; },
        abortSignal(signal) { telemetrySignals.push(signal); return query; },
        maybeSingle: execute,
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return query;
    },
  };
  const auth = load("lib/agent-auth.server.ts", {
    crypto, "./server-supabase": { adminClient: () => admin },
  });
  const modules = {
    "@tanstack/react-router": { createFileRoute: () => config => config },
    "@/lib/agent-auth.server": auth,
    "@/lib/authorization.server": load("lib/authorization.server.ts"),
    "@/lib/agent-http-diagnostics.server": diagnostics.modules,
    "@/lib/bounded-telemetry.server": load("lib/bounded-telemetry.server.ts", {}, {
      ...diagnostics.clock, AbortController,
    }),
    "@/lib/licensing.server": load("lib/licensing.server.ts"),
    "@/shared/legacy-monitor": { legacyMonitorMayBeDelivered: () => false },
  };
  const file = operation === "frame" ? "session.$sessionId.frame" : "heartbeat";
  const handler = load(`routes/api/public/agent/${file}.ts`, modules).Route.server.handlers.POST;
  return {
    ...diagnostics, writes, reads, telemetrySignals,
    call(body = operation === "frame" ? { frame: "PRIVATE_FRAME", width: 10, height: 20 } : {
      runtime: { instance: "22222222-2222-4222-8222-222222222222", sequence: 1, heartbeat_seconds: 5 },
    }) {
      return handler({
        request: new Request("https://fixture.invalid/PRIVATE_PATH?token=PRIVATE_QUERY", {
          method: "POST", body: JSON.stringify(body),
          headers: {
            "X-Device-Id": "fixture-public-id", "X-Device-Token": options.invalidToken ? "wrong" : "fixture-token",
            "X-ConnectLive-Request-Id": "clh-" + "a".repeat(32),
            authorization: "Bearer PRIVATE_AUTH", cookie: "PRIVATE_COOKIE",
          },
        }),
        params: { sessionId: "fixture-session" },
      });
    },
  };
}
module.exports = { load, diagnosticsFixture, routeFixture };
