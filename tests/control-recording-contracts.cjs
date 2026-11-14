const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto").webcrypto;

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`src/${file}`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require(name) {
    if (!(name in dependencies)) throw Error(`Unmocked import: ${name}`);
    return dependencies[name];
  }, Response, Request, URL, AbortController, TextEncoder, crypto, ...globals });
  return exports;
}
const ids = {
  session: "11111111-1111-4111-8111-111111111111",
  grant: "22222222-2222-4222-8222-222222222222",
  device: "33333333-3333-4333-8333-333333333333",
  instance: "44444444-4444-4444-8444-444444444444",
  controller: "web-55555555-5555-4555-8555-555555555555",
};
const authorization = load("lib/authorization.server.ts");
const identity = load("shared/signaling-identity.ts");
function fixture(overrides = {}) {
  const calls = [];
  const session = {
    id: ids.session, device_id: ids.device, state: "active", mode: "control",
    authorization_id: ids.grant, admin_client_id: ids.controller, technician_id: "technician",
    ...overrides.session,
  };
  const grant = {
    id: ids.grant, noticeVersion: 1, mode: "unattended",
    capabilities: { view: true, control: true, clipboard: false, files: true, recording: true },
    recordedAt: "2026-11-09T12:00:00Z", revokedAt: null, ...overrides.grant,
  };
  const admin = {
    auth: { getUser: async () => ({ data: { user: { id: overrides.actor ?? "technician" } }, error: null }) },
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; },
        then(resolve, reject) {
          calls.push(table);
          return Promise.resolve({
            data: (overrides.roles ?? ["admin"]).map(role => ({ role })),
            error: overrides.failTable === table ? { message: "synthetic failure" } : null,
          }).then(resolve, reject);
        },
        async maybeSingle() {
          calls.push(table);
          return { data: table === "sessions" ? session :
            { agent_instance: ids.instance, agent_state: "running", ...overrides.runtime },
            error: overrides.failTable === table ? { message: "synthetic failure" } : null };
        },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push([name, args?._capability]);
      if (name === "has_role") return { data: false, error: null };
      if (name === "device_authorization") return { data: grant, error: null };
      return {
        data: overrides.allowed !== false && (args._capability !== "control" || overrides.control !== false),
        error: overrides.failCapability === args._capability ? { message: "synthetic failure" } : null,
      };
    },
  };
  const dependencies = {
    "@tanstack/react-router": { createFileRoute: () => value => value },
    "@/lib/server-supabase": { adminClient: () => admin },
    "@/lib/authorization.server": authorization,
    "@/lib/licensing.server": { evaluateLicense: async () => ({ state: overrides.licenseState ?? "unlicensed" }) },
    "@/shared/signaling-identity": identity,
    "@/lib/agent-auth.server": {
      verifyDevice: async () => overrides.deviceDenied ? { kind: "unauthorized" } :
        { kind: "verified", admin, device: { id: ids.device } },
      deviceAuthFailure: () => new Response("unauthorized", { status: 401 }),
    },
  };
  const permission = load("routes/api/public/agent/session.$sessionId.permission.ts", dependencies).Route.server.handlers.GET;
  const recording = load("routes/api/public/admin/session.$sessionId.authorization.ts", dependencies).Route.server.handlers.GET;
  return {
    calls,
    permission: (changes = {}) => {
      const query = new URLSearchParams({ mode: "control", authorization_id: ids.grant,
        admin_client_id: ids.controller, instance: ids.instance, ...changes });
      return permission({ request: new Request(`https://fixture.invalid/permission?${query}`), params: { sessionId: ids.session } });
    },
    recording: () => recording({ request: new Request("https://fixture.invalid/authorization",
      { headers: { authorization: "Bearer synthetic-unit-token" } }), params: { sessionId: ids.session } }),
  };
}
test("targeted permission accepts the real web- controller format and performs a fresh control check", async () => {
  const f = fixture();
  const response = await f.permission();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).mode, "control");
  assert(f.calls.some(value => Array.isArray(value) && value[0] === "session_authorized" && value[1] === "control"));
});
for (const [name, options, status] of [
  ["wrong device credential", { deviceDenied: true }, 401],
  ["foreign grant", { session: { authorization_id: "other" } }, 409],
  ["superseded controller", { session: { admin_client_id: "different-admin" } }, 409],
  ["ended session", { session: { state: "ended" } }, 409],
  ["view mode", { session: { mode: "view" } }, 409],
  ["retired process", { runtime: { agent_instance: "other" } }, 409],
  ["stopped process", { runtime: { agent_state: "stopped" } }, 409],
  ["revoked authority", { allowed: false }, 403],
  ["viewer session owner", { roles: ["viewer"] }, 403],
  ["owner without a staff role", { roles: [] }, 403],
  ["unowned session", { session: { technician_id: null } }, 403],
  ["unavailable current role", { failTable: "user_roles" }, 503],
  ["expired license", { licenseState: "expired" }, 403],
  ["unavailable process read", { failTable: "agent_runtime" }, 503],
  ["unavailable authority", { failCapability: "control" }, 503],
]) test(`targeted permission rejects ${name}`, async () => assert.equal((await fixture(options).permission()).status, status));
test("view-only permission still works after a control-role downgrade", async () => {
  const response = await fixture({ roles: ["viewer"], session: { mode: "view" } }).permission({ mode: "view" });
  assert.equal(response.status, 200);
});
test("recording capabilities reuse the immutable bound grant, not seven repeated capability RPCs", async () => {
  const f = fixture({ control: false });
  const response = await f.recording();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.authorizationId, ids.grant);
  assert.equal(body.capabilities.control, false);
  assert.equal(body.capabilities.recording, true);
  assert.equal(body.capabilities.clipboard, false);
  assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === "session_authorized").length, 2);
});
for (const [name, options, status, allowed] of [
  ["revoke at final revalidation", { allowed: false }, 200, false],
  ["replacement grant", { grant: { id: ids.instance } }, 200, false],
  ["revoked snapshot", { grant: { revokedAt: "2026-11-09T13:00:00Z" } }, 200, false],
  ["unavailable authority", { failCapability: "view" }, 503],
  ["session lookup failure", { failTable: "sessions" }, 503],
  ["foreign technician", { actor: "someone-else" }, 403],
]) test(`recording authorization fails closed for ${name}`, async () => {
  const response = await fixture(options).recording();
  assert.equal(response.status, status);
  if (allowed !== undefined) {
    const value = await response.json();
    assert.equal(value.allowed, allowed);
    assert.equal(value.capabilities.recording, false);
  }
});
test("the output extension follows actual MediaRecorder MIME, including codec parameters", () => {
  const output = load("lib/recording-output.ts");
  assert.equal(output.recordingFilename("session-id", "video/mp4;codecs=avc1.42E01E", 123), "connectlive-session--123.mp4");
  assert.equal(output.recordingExtension("video/webm;codecs=vp8"), "webm");
  assert.equal(output.recordingExtension("VIDEO/MP4"), "mp4");
  assert.throws(() => output.recordingFilename("session", "application/octet-stream"), /unsupported container/);
});
function actionsFixture() {
  const timers = new Map(), messages = [];
  let next = 0;
  const globals = {
    setTimeout(fn) { timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); },
  };
  const curtain = load("lib/browser-curtain.ts", {}, globals);
  const inputPause = load("lib/browser-input-pause.ts", {}, globals);
  const actions = load("lib/browser-actions.ts", {
    "./browser-curtain": curtain,
    "./browser-input-pause": inputPause,
    "./browser-unlock": { createBrowserUnlock: () => ({ reset() {}, receive() {}, dispose() {} }) },
  }, globals).createBrowserActions(ids.session, ids.grant, () => ({
    readyState: "open", bufferedAmount: 0, send: text => messages.push(JSON.parse(text)),
  }), () => true, () => {});
  const receipt = (changes = {}) => actions.receive(JSON.stringify({
    kind: "permission_status", session_id: ids.session, authorization_id: ids.grant,
    mode: "view", permission_refresh_supported: true, ...changes,
  }));
  receipt();
  return { actions, timers, messages, receipt };
}
test("fresh permission replies require the matching session, grant, request and mode", async () => {
  const f = actionsFixture(), cancel = new AbortController();
  const pending = f.actions.refreshMode("control", cancel.signal);
  const request = f.messages.at(-1).payload.request_id;
  let done = false;
  pending.then(() => { done = true; });
  f.receipt({ request_id: request, status: "applied", mode: "control", authorization_id: ids.instance });
  f.receipt({ request_id: "wrong", status: "applied", mode: "control" });
  await Promise.resolve();
  assert.equal(done, false);
  f.receipt({ request_id: request, status: "applied", mode: "control" });
  await pending;
  assert.equal(done, true);
});
test("cancelling a mode refresh ignores its late reply and sends no curtain activation", async () => {
  const f = actionsFixture(), cancel = new AbortController();
  const pending = f.actions.refreshMode("control", cancel.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  const request = f.messages.at(-1).payload.request_id;
  cancel.abort(); await rejected;
  f.receipt({ request_id: request, mode: "control", status: "applied" });
  assert(!f.messages.some(message => message.kind === "curtain_on"));
});
test("unavailable targeted permission times out, never treating transport send as application", async () => {
  const f = actionsFixture();
  const pending = f.actions.refreshMode("control", new AbortController().signal);
  const rejected = assert.rejects(pending, /could not refresh/);
  for (const fn of [...f.timers.values()]) fn();
  await rejected;
});
test("storage-disabled browsers reuse one controller identity across signaling and mode writes", () => {
  const identity = load("shared/signaling-identity.ts", {}, {
    localStorage: { getItem() { throw Error("storage unavailable"); } },
  });
  assert.equal(identity.getWebClientId(), identity.getWebClientId());
});
