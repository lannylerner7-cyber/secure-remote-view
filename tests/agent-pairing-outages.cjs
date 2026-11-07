const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { pairingRouteFixture, routes, token } = require("./helpers/agent-pairing.cjs");
const { routeFixture } = require("./helpers/agent-http.cjs");

test("every device-authenticated route is included in the outage matrix", () => {
  const root = "src/routes/api/public/agent/";
  const actual = fs.readdirSync(root).filter(file => file.endsWith(".ts") &&
    fs.readFileSync(root + file, "utf8").includes("verifyDevice"));
  const covered = [...new Set(routes.map(([file]) => file + ".ts")),
    "heartbeat.ts", "session.$sessionId.frame.ts"];
  assert.deepEqual(actual.sort(), covered.sort());
  for (const file of actual) {
    const source = fs.readFileSync(root + file, "utf8");
    assert.doesNotMatch(source, /if \(!ctx\)|verifyDevice\(request,\s*\(/);
  }
});

for (const route of routes) {
  const name = `${route[1]} ${route[0]}`;
  test(`${name}: verified identity follows the authorized path`, async () => {
    const f = pairingRouteFixture(route);
    assert.equal((await f.call()).status, 200);
    assert.ok(f.reads.some(read => read.table === "devices"));
    assert.equal(f.technicianChecks, 0);
  });

  test(`${name}: missing credentials and genuine rejection remain 401`, async () => {
    for (const scenario of ["missing-header", "bad-token", "missing-device", "missing-hash"]) {
      const f = pairingRouteFixture(route);
      if (scenario === "missing-device") f.lookup = "missing";
      if (scenario === "missing-hash") f.device.metadata = {};
      const response = await f.call(scenario === "missing-header" ? {} : {
        "x-device-id": f.device.device_id, "x-device-token": scenario === "bad-token" ? "wrong" : token,
      });
      assert.equal(response.status, 401, scenario);
      const body = await response.text();
      assert.doesNotMatch(body, /PRIVATE/);
      // Preserve the existing anonymous technician/ICE response shapes too.
      if (scenario !== "missing-header") {
        assert.match(body, /unauthorized/);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      assert.equal(f.writes.length, 0);
      assert.equal(f.technicianChecks, 0);
      assert.ok(!f.request.bodyUsed, "unverified request bodies are not consumed");
      if (scenario === "missing-header") assert.equal(f.reads.length, 0);
    }
  });

  test(`${name}: database, network and client-setup outages are 503, then recover`, async () => {
    const f = pairingRouteFixture(route);
    for (const failure of ["database", "network", "setup"]) {
      f.lookup = failure;
      const response = await f.call();
      assert.equal(response.status, 503, failure);
      assert.match(await response.text(), /device_lookup_unavailable/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(f.writes.length, 0);
      assert.equal(f.technicianChecks, 0);
      assert.equal(f.providerCalls, 0);
      assert.equal(f.subscriptions, 0);
      assert.ok(f.reads.every(read => read.table === "devices"), "no work beyond the unavailable identity lookup");
      assert.ok(!f.request.bodyUsed, "an outage cannot consume sensitive request bodies");
      assert.doesNotMatch(f.logs.join("\n"), /PRIVATE/);
    }
    f.lookup = "ok";
    assert.equal((await f.call()).status, 200, "same saved identity succeeds once the lookup recovers");
    assert.equal(f.request.headers.get("x-device-token"), token);
  });
}

for (const file of ["ice", "release"]) {
  test(`${file}: a supplied device identity never falls back to a technician`, async () => {
    const route = routes.find(([name]) => name === file);
    for (const failure of ["database", "network", "missing", "bad-token", "partial-header"]) {
      const f = pairingRouteFixture(route);
      f.lookup = failure;
      const headers = { authorization: "Bearer PRIVATE_TECH_TOKEN", "x-device-id": f.device.device_id };
      if (failure !== "partial-header") headers["x-device-token"] = failure === "bad-token" ? "wrong" : token;
      const response = await f.call(headers);
      assert.equal(response.status, ["database", "network"].includes(failure) ? 503 : 401);
      assert.equal(f.technicianChecks, 0);
      assert.equal(f.providerCalls, 0);
    }
    const f = pairingRouteFixture(route);
    assert.equal((await f.call({ authorization: "Bearer PRIVATE_TECH_TOKEN" })).status, 200);
    assert.equal(f.technicianChecks, 1, "technician-only callers retain their separate path");
  });
}

for (const operation of ["frame", "heartbeat"]) {
  test(`${operation}: thrown lookup/RPC failures are unavailable, redacted and recoverable`, async () => {
    for (const stage of ["device_auth", "session_authorization"]) {
      const options = { throwAt: stage };
      const f = routeFixture(operation, options);
      const response = await f.call();
      assert.equal(response.status, 503);
      assert.match(await response.text(), /unavailable/);
      assert.ok(!f.writes.some(write => ["sessions", "session_frames"].includes(write.table)));
      assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE/);
      options.throwAt = null;
      assert.equal((await f.call()).status, 200);
    }
  });
}

for (const [file, method, denial] of [
  ["session.$sessionId.cursor", "POST", 409],
  ["session.$sessionId.file", "POST", 409],
  ["session.$sessionId.signal", "POST", 409],
  ["session.$sessionId.signal", "GET", 403],
  ["session.$sessionId.reconnect", "POST", 409],
  ["ice", "GET", 403],
]) {
  test(`${method} ${file}: verified identity does not bypass session permissions`, async () => {
    for (const permission of ["denied", "database", "network"]) {
      const f = pairingRouteFixture(routes.find(([name, verb]) => name === file && verb === method));
      f.permission = permission;
      const response = await f.call();
      assert.equal(response.status, denial);
      assert.equal(f.writes.length, 0);
      assert.equal(f.providerCalls, 0);
      assert.doesNotMatch(await response.text(), /PRIVATE/);
      assert.doesNotMatch(f.logs.join("\n"), /PRIVATE/);
    }
  });
}

test("input polling still delivers only safety cleanup when permissions are unavailable", async () => {
  const f = pairingRouteFixture(routes.find(([file]) => file.endsWith(".inputs")));
  for (const permission of ["denied", "database", "network"]) {
    f.permission = permission;
    const response = await f.call();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items.map(item => item.kind), ["curtain_off"]);
    assert.equal(f.writes.length, 0);
  }
});

test("authorization lookup outages do not become identity failures", async () => {
  for (const route of routes.filter(([file, method]) =>
    (file === "authorization" && method === "GET") || file === "beacon" || file.endsWith(".consent"))) {
    for (const permission of ["database", "network"]) {
      const f = pairingRouteFixture(route);
      f.permission = permission;
      const response = await f.call();
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /PRIVATE/);
      assert.equal(f.writes.length, 0);
    }
  }
});

test("native identity changes require explicit successful pairing; diagnostics remain redacted", () => {
  const client = fs.readFileSync("agent/src/ApiClient.cs", "utf8");
  const pairing = fs.readFileSync("agent/src/ApiClient.Pairing.cs", "utf8");
  assert.match(pairing, /SaveDeviceCreds[\s\S]*GrantStore\.Save\(local\);[\s\S]*SetPairedIdentity/);
  const pollStart = client.indexOf("public async Task<(long max, System.Collections.Generic.List<JsonElement>? items)> PollSignalsAsync");
  const pollEnd = client.indexOf("private void NoteSignalPollFailure", pollStart);
  assert.ok(pollStart >= 0 && pollEnd > pollStart);
  const poll = client.slice(pollStart, pollEnd);
  assert.doesNotMatch(poll, /ex\.Message|text\[\.\.160\]|HTTP.*detail/);
  assert.match(client, /NoteSignalPollFailure\(AgentHttpDiagnostics\.SafeFailure/);
});
