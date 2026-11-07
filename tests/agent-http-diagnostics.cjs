const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { diagnosticsFixture, routeFixture } = require("./helpers/agent-http.cjs");

test("frame records bounded metadata and correlation, not payloads, identities or credentials", async () => {
  const f = routeFixture("frame");
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-connectlive-request-id"), "clh-" + "a".repeat(32));
  assert.equal(response.headers.get("x-connectlive-stage"), "frame_write");
  assert.equal(response.headers.get("x-connectlive-outcome"), "ok");
  assert.ok(Number(response.headers.get("x-connectlive-server-ms")) > 0);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].table, "session_frames");
  assert.ok(f.logs[0].stages_ms.device_auth > 0);
  assert.ok(f.logs[0].stages_ms.session_authorization > 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|fixture-(device|public-id|token|session)/);
  assert.equal(f.timers.size, 0);
});

for (const [name, options, status, outcome] of [
  ["bad token", { invalidToken: true }, 401, "unauthorized"],
  ["wrong owner", { session: { device_id: "other-device" } }, 404, "not_found"],
  ["video-only session", { session: { media_mode: "video" } }, 409, "video_only_session"],
  ["ended session", { session: { state: "ended" } }, 409, "not_active"],
  ["revoked authorization", { allowed: false }, 409, "not_active"],
  ["unavailable identity lookup", { fail: "device_auth" }, 503, "device_lookup_unavailable"],
  ["unavailable session lookup", { fail: "sessions_lookup" }, 503, "session_lookup_unavailable"],
  ["unavailable permission RPC", { fail: "session_authorization" }, 503, "session_authorization_unavailable"],
]) test(`frame denies ${name} without writing`, async () => {
  const f = routeFixture("frame", options);
  const response = await f.call();
  assert.equal(response.status, status);
  assert.equal(response.headers.get("x-connectlive-outcome"), outcome);
  assert.equal(f.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
});

test("frame body limits and storage errors have distinct sanitized outcomes", async () => {
  for (const frame of [undefined, "", 123, "x".repeat(2_000_001)]) {
    const f = routeFixture("frame");
    const response = await f.call({ frame });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-connectlive-outcome"), "invalid_frame");
    assert.equal(f.writes.length, 0);
  }
  const f = routeFixture("frame", { fail: "frame_write" });
  const response = await f.call();
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "frame_write_failed");
  assert.equal(f.logs[0].stage, "frame_write");
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
});

test("heartbeat preserves the authorized journey, runtime cadence and response contract", async () => {
  const f = routeFixture("heartbeat");
  const response = await f.call();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.is_session_active, true);
  assert.equal(body.sessions[0].id, "fixture-session");
  assert.equal(body.authorization.noticeVersion, 1);
  assert.equal(body.license.state, "active");
  assert.deepEqual(body.reporting_warnings, []);
  assert.ok(f.reads.includes("runtime_write"));
  assert.ok(f.logs[0].stages_ms.license_evaluation > 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|fixture-(device|public-id|token|session)/);
  const presence = f.writes.find(w => w.table === "devices").values;
  assert.equal(presence.last_seen_at, undefined, "runtime RPC retains ownership of process presence");
});

test("heartbeat returns only the exact device/grant's explicit session completion", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const f = routeFixture("heartbeat", {
    session: { id },
    statusRecord: { id, state: "ended", authorization_id: "11111111-1111-4111-8111-111111111111", device_id: "fixture-device" },
  });
  const response = await f.call({ observed_session_id: id });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).session_status.state, "ended");
  assert.ok(f.reads.includes("session_status_lookup"));
  assert.doesNotMatch(JSON.stringify(f.logs), /33333333|fixture-device/);
});

for (const field of ["id", "device_id", "authorization_id"]) {
  test(`heartbeat hides another ${field}'s terminal record`, async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const f = routeFixture("heartbeat", { statusRecord: {
      id, state: "ended", device_id: "fixture-device",
      authorization_id: "11111111-1111-4111-8111-111111111111", [field]: "different",
    } });
    const response = await f.call({ observed_session_id: id });
    assert.equal((await response.json()).session_status, null);
  });
}

test("optional terminal lookup outage never fabricates a completion or interrupts valid live authority", async () => {
  const f = routeFixture("heartbeat", { fail: "session_status_lookup" });
  const response = await f.call({ observed_session_id: "33333333-3333-4333-8333-333333333333" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.session_status, null);
  assert.equal(body.is_session_active, true);
  assert.deepEqual(body.reporting_warnings, ["session_status_unavailable"]);
});

test("heartbeat rejects an invalid observed session without attempting a lookup", async () => {
  const f = routeFixture("heartbeat");
  assert.equal((await f.call({ observed_session_id: "../other" })).status, 400);
  assert.ok(!f.reads.includes("session_status_lookup"));
});

for (const stage of ["device_auth", "authorization", "runtime_write", "presence_write",
  "license_lookup", "license_state_write", "sessions_lookup", "session_authorization", "session_cleanup"]) {
  test(`heartbeat reports ${stage} outage without returning session authority`, async () => {
    const f = routeFixture("heartbeat", {
      fail: stage,
      ...(stage === "license_state_write" ? { device: { license_state: "blocked" } } : {}),
      ...(stage === "session_cleanup" ? { allowed: false } : {}),
    });
    const response = await f.call();
    assert.equal(response.status, 503);
    assert.equal(f.logs[0].stage, stage);
    assert.doesNotMatch(await response.text(), /PRIVATE|fixture-session|"authorization"/);
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
    if (stage === "session_authorization")
      assert.ok(!f.writes.some(w => w.table === "sessions"), "RPC outage must not end database sessions");
  });
}

test("heartbeat still denies invalid credentials, runtime reports and retired processes", async () => {
  assert.equal((await routeFixture("heartbeat", { invalidToken: true }).call()).status, 401);
  assert.equal((await routeFixture("heartbeat").call({ runtime: {} })).status, 400);
  assert.equal((await routeFixture("heartbeat", { recorded: false }).call()).status, 409);
  const f = routeFixture("heartbeat", { allowed: false });
  const body = await (await f.call()).json();
  assert.equal(body.is_session_active, false);
  assert.deepEqual(body.sessions, []);
  assert.ok(f.writes.some(w => w.table === "sessions" && w.values.state === "ended"));
});

test("notification error remains a warning rather than revoking healthy authority", async () => {
  const f = routeFixture("heartbeat", { fail: "notification_write", device: { status: "offline" } });
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-connectlive-outcome"), "notification_failed");
  const body = await response.json();
  assert.equal(body.is_session_active, true);
  assert.deepEqual(body.reporting_warnings, ["reconnection_notification_failed"]);
});

test("unexpected upstream exceptions are redacted and do not escape into framework logs", async () => {
  const f = routeFixture("frame", { throwAt: "frame_write" });
  const response = await f.call();
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "agent_request_failed");
  assert.equal(response.headers.get("x-connectlive-outcome"), "handler_exception");
  assert.equal(f.logs[0].stage, "frame_write");
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
  assert.equal(f.timers.size, 0);
});

test("slow and aborted requests identify the outstanding stage before completion", async () => {
  const f = diagnosticsFixture();
  let resolve;
  const waiting = new Promise(done => { resolve = done; });
  const abort = new AbortController();
  const request = new Request("https://fixture.invalid", { signal: abort.signal });
  const pending = f.modules.withAgentHttpDiagnostics(request, "frame", async trace => {
    await trace.step("frame_write", () => waiting);
    return new Response("ok");
  });
  f.advance(2_000);
  assert.equal(f.logs[0].event, "slow");
  assert.equal(f.logs[0].stage, "frame_write");
  assert.equal(f.logs[0].status, 0);
  abort.abort();
  assert.equal(f.logs[1].event, "aborted");
  resolve();
  assert.equal((await pending).status, 200, "observations do not invent cancellation of an upstream write");
  assert.equal(f.timers.size, 0);
});

test("untrusted IDs, URLs, headers and response bodies cannot enter diagnostics", async () => {
  const f = diagnosticsFixture();
  const response = await f.modules.withAgentHttpDiagnostics(new Request("https://fixture.invalid/PRIVATE_URL", {
    headers: { "x-connectlive-request-id": "PRIVATE_TOKEN".repeat(100) },
  }), "heartbeat", async () => new Response("PRIVATE_RESPONSE", { status: 502 }));
  assert.match(response.headers.get("x-connectlive-request-id"), /^clh-[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
});

test("logging is bounded even under outage and success/failure flapping", async () => {
  const f = diagnosticsFixture();
  const run = (op, status) => f.modules.withAgentHttpDiagnostics(
    new Request("https://fixture.invalid"), op, async () => new Response("", { status }));
  for (let i = 0; i < 100; i++) {
    await run("frame", 503);
    await run("frame", 200);
  }
  assert.equal(f.logs.filter(l => l.status === 503).length, 6);
  assert.equal(f.logs.filter(l => l.status === 200).length, 1);
  assert.ok(f.logs.every(l => JSON.stringify(l).length < 2_000));
  await run("heartbeat", 503);
  assert.equal(f.logs.at(-1).operation, "heartbeat", "frame noise cannot suppress heartbeat diagnostics");
  f.advance(60_000);
  await run("frame", 503);
  assert.equal(f.logs.at(-1).suppressed, 94);
  assert.equal(f.timers.size, 0);
});

test("native integration retains deadlines, bounded queue and fail-closed authority handling", () => {
  const client = fs.readFileSync("agent/src/ApiClient.cs", "utf8");
  const auth = fs.readFileSync("agent/src/ApiClient.Authentication.cs", "utf8");
  const capture = fs.readFileSync("agent/src/ScreenCapture.cs", "utf8");
  const agent = fs.readFileSync("agent/src/Agent.cs", "utf8");
  assert.match(client, /Timeout = TimeSpan\.FromSeconds\(20\)/);
  assert.match(client, /deadline\.CancelAfter\(TimeSpan\.FromSeconds\(3\)\)/);
  assert.match(client, /deadline\.Token, AgentHttpOperation\.Frame, lifetime\.Token/);
  assert.match(client, /ct, AgentHttpOperation\.Heartbeat/);
  assert.match(client, /if \(!Allows\(sessionId, "view", ct\) \|\| permission == null\) return false/);
  assert.match(client, /CreateLinkedTokenSource\(ct, permission\.Token\)/);
  assert.match(auth, /using var req = build\(\)/);
  assert.match(auth, /await _httpDiagnostics\.SendAsync\(_http, req, operation, ct, lifetime \?\? ct, 1\)/);
  assert.match(auth, /HttpStatusCode\.Unauthorized or HttpStatusCode\.Forbidden[\s\S]*?LivePermission\?\.Revoke\(\)/);
  assert.doesNotMatch(auth, /File\.|DevicePath|EnrollIfNeededAsync|PairingProvider|req2/);
  assert.doesNotMatch(client, /File\.Delete\(DevicePath\)|DeviceToken = null|DeviceId = null/);
  assert.match(capture, /new LatestWorkPump</);
  assert.doesNotMatch(capture, /fallback upload failed/);
  assert.match(agent, /_authorityMatches = false;\s*EndSession\(\);\s*Log\.Warn\(\$"heartbeat failed/);
  assert.match(agent, /if \(fails >= 3 && !deadManTripped\)/);
  assert.match(agent, /deadManTripped = true;\s*EndSession\(\);/);
});
