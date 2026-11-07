// Isolated source/handler checks. No database, device, Windows build or session is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");
const { stubDeviceAuth } = require("./helpers/device-auth.cjs");
function load(path, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports, Response, Date,
    require: (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}
const { selectSessionMediaMode, replaceWithJpegDiagnostic } =
  load("src/lib/jpeg-diagnostic.ts");

test("new sessions permit automatic JPEG fallback while still attempting video", () => {
  assert.equal(selectSessionMediaMode("windows", { browser_video: 1 }), "legacy");
  assert.equal(selectSessionMediaMode("windows", { browser_video: 1 }, true), "legacy");
  assert.equal(selectSessionMediaMode("windows", {}), "legacy");
  assert.equal(selectSessionMediaMode("android", {}), "legacy");
  assert.equal(selectSessionMediaMode(undefined, null), "legacy");
  assert.throws(() => selectSessionMediaMode("android", {}, true));
  assert.throws(() => selectSessionMediaMode("windows", {}, true));
});

test("replacement invite waits for successful session termination", async () => {
  const order = [];
  assert.equal(await replaceWithJpegDiagnostic(
    async () => { order.push("ended"); return true; },
    async () => { order.push("invited"); return true; },
  ), true);
  assert.deepEqual(order, ["ended", "invited"]);
});

test("failed end, thrown end and failed invite cannot report success", async () => {
  let invites = 0;
  const invite = async () => { invites++; return true; };
  assert.equal(await replaceWithJpegDiagnostic(async () => false, invite), false);
  await assert.rejects(replaceWithJpegDiagnostic(async () => { throw Error("denied"); }, invite));
  assert.equal(invites, 0);
  assert.equal(await replaceWithJpegDiagnostic(async () => true, async () => false), false);
});

function frameEndpoint({ verified = true, owner = "fixture-device", state = "active", mode = "legacy", authorized = true } = {}) {
  const writes = [];
  const admin = {
    from(table) {
      if (table === "sessions") return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: { id: "fixture-session", device_id: owner, state, media_mode: mode } }; },
      };
      if (table === "session_frames") return {
        async upsert(row) { writes.push(row); return { error: null }; },
      };
      throw Error(`Unexpected table: ${table}`);
    },
  };
  const { Route } = load("src/routes/api/public/agent/session.$sessionId.frame.ts", {
    "@tanstack/react-router": { createFileRoute: () => (options) => options },
    "@/lib/agent-auth.server": stubDeviceAuth(() => verified ? { device: { id: "fixture-device" }, admin } : null),
    "@/lib/authorization.server": { sessionAuthorized: async () => authorized },
    "@/lib/agent-http-diagnostics.server": {
      withAgentHttpDiagnostics: (_request, _operation, run) => run({
        step: (_stage, work) => work(), respond: response => response,
      }),
    },
  });
  return {
    writes,
    call: () => Route.server.handlers.POST({
      request: new Request("https://fixture.invalid/frame", {
        method: "POST", body: JSON.stringify({ frame: "unit-test-frame", width: 1280, height: 720 }),
      }),
      params: { sessionId: "fixture-session" },
    }),
  };
}

test("authorized legacy session can receive a JPEG through the existing endpoint", async () => {
  const fixture = frameEndpoint();
  assert.equal((await fixture.call()).status, 200);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].session_id, "fixture-session");
  assert.equal(fixture.writes[0].width, 1280);
});

for (const [name, options, status] of [
  ["unverified device", { verified: false }, 401],
  ["different device", { owner: "other-device" }, 404],
  ["video-only session", { mode: "video" }, 409],
  ["ended session", { state: "ended" }, 409],
  ["revoked viewing authorization", { authorized: false }, 409],
]) {
  test(`${name} still cannot write frames`, async () => {
    const fixture = frameEndpoint(options);
    assert.equal((await fixture.call()).status, status);
    assert.equal(fixture.writes.length, 0);
  });
}

test("UI keeps role, confirmation, busy guard and view-only invitation", () => {
  const source = fs.readFileSync("src/routes/_authenticated/console.tsx", "utf8");
  assert.match(source, /!canMutate \|\| jpegDiagnosticBusyRef\.current/);
  assert.match(source, /const canMutate = role === "super_admin" \|\| role === "admin" \|\| role === "technician"/);
  assert.match(source, /s\.media_mode === "video" && s\.device_id && canMutate &&/);
  assert.match(source, /if \(!confirm\("End this session and invite a new view-only session/);
  assert.match(source, /replaceWithJpegDiagnostic\(\(\) => endSession\(s\), \(\) => connectDevice\(device, true\)\)/);
  assert.match(source, /mode: "view",\s*state: "invited"/);
  assert.match(source, /if \(lookupError\)/);
  assert.match(source, /data-testid="button-jpeg-diagnostic"/);
  assert.match(source, /data-testid="jpeg-diagnostic-status"/);
  assert.match(source, /Enable JPEG fallback/);
  assert.match(source, /data-testid="video-only-session-notice"/);
  assert.match(source, /observeVideoFrames\(viewerVideo/);
  assert.match(source, /\[liveId, rtcVideoLive, viewerVideo\]/);
});

test("idle JPEG freshness stays permission-gated and video-only capture stays off", () => {
  const source = fs.readFileSync("agent/src/ScreenCapture.cs", "utf8");
  const refresh = source.split("void RefreshUnchangedJpeg()")[1].split("// S17")[0];
  assert.match(refresh, /if \(videoOnly \|\| ct\.IsCancellationRequested \|\| !permission\.Allows\("view"\)\) return/);
  assert.match(refresh, /if \(jpegDirty \|\| !latestJpeg\.HasValue/);
  assert.match(refresh, /Math\.Max\(1000, Interlocked\.Read\(ref jpegIntervalMs\)\)/);
  assert.match(source, /else if \(dxgi\.IsInitialized && !dxgi\.LastFrameHadContentChange && lastFrame != null\)/);
  assert.match(source, /await using var uploads = videoOnly \? null/);
  assert.match(source, /latestJpeg = null;\s*jpegDirty = true;\s*ResetWebRtcTee/);
});
