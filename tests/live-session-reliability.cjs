const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve("src/lib");
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

function runtime() {
  let now = 0, next = 0;
  const timers = new Map(), modules = new Map();
  const clock = {
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  function load(name) {
    const file = path.resolve(root, `${name}.ts`);
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports, AbortController, ...clock,
      require(id) {
        assert.ok(id.startsWith("."), `unexpected import ${id}`);
        return load(path.relative(root, path.resolve(path.dirname(file), id)));
      },
    });
    return exports;
  }
  return { load, timers, async advance(ms) {
    const end = now + ms;
    while (true) {
      const nextTimer = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!nextTimer) break;
      const [id, timer] = nextTimer;
      now = timer.at; timers.delete(id); timer.fn(); await flush();
    }
    now = end; await flush();
  } };
}
const row = (id, kind = "ice", overrides = {}) => ({
  id, kind, from_side: "agent", admin_client_id: "web-fixture",
  payload: { peer_id: "current-peer" }, ...overrides,
});
function inboxFixture(apply = async () => {}) {
  const f = runtime(), applied = [];
  let active = true;
  const inbox = f.load("remote-signal-inbox").createRemoteSignalInbox({
    peerId: "current-peer", clientId: "web-fixture", strict: true, minimumId: 0,
    active: () => active, apply, applied: id => applied.push(id),
  });
  return { inbox, applied, stop: () => { active = false; } };
}

test("catch-up can apply a missing answer even after a higher-ID realtime candidate", async () => {
  const kinds = [], f = inboxFixture(async row => { kinds.push(row.kind); });
  await f.inbox.accept(row(102));
  await f.inbox.accept(row(101, "answer"));
  await f.inbox.accept(row(102));
  assert.deepEqual(f.applied, [102, 101]);
  assert.deepEqual(kinds, ["ice", "answer"]);
});

test("overlapping snapshot/realtime deliveries apply once, including an in-flight answer", async () => {
  let release, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = inboxFixture(async () => { count++; await gate; });
  const first = f.inbox.accept(row(5, "answer"));
  const second = f.inbox.accept(row(5, "answer"));
  await flush(); assert.equal(count, 1);
  release(); await Promise.all([first, second]);
  assert.deepEqual(f.applied, [5]);
});

test("wrong controller, old peer, untagged strict replies and malformed rows never apply", async () => {
  const f = inboxFixture();
  for (const value of [
    row(1, "answer", { admin_client_id: "another-controller" }),
    row(2, "answer", { payload: { peer_id: "retired-peer" } }),
    row(3, "answer", { payload: {} }), row(4, "offer"),
    row(5, "ice", { from_side: "admin" }), row(NaN), row(-1), null,
  ]) await f.inbox.accept(value);
  assert.equal(f.applied.length, 0);
});

test("a failed application is retryable; a retired inbox never resumes", async () => {
  let fail = true;
  const f = inboxFixture(async () => { if (fail) throw Error("synthetic failure"); });
  await assert.rejects(f.inbox.accept(row(1, "answer")));
  fail = false;
  await f.inbox.accept(row(1, "answer"));
  assert.deepEqual(f.applied, [1]);
  f.inbox.close();
  await f.inbox.accept(row(2));
  assert.deepEqual(f.applied, [1]);
});

test("signal capacity is bounded without forgetting and replaying old answers", async () => {
  const f = inboxFixture();
  for (let i = 1; i <= 512; i++) await f.inbox.accept(row(i));
  await assert.rejects(f.inbox.accept(row(513)), /capacity/);
  await f.inbox.accept(row(1));
  assert.equal(f.applied.length, 512);
});

test("safe diagnostics distinguish configured TURN from the actual selected direct/relay pair", () => {
  const { summarizeRtcStats } = runtime().load("live-diagnostics");
  const rows = [
    { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
    { id: "unselected", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "unused" },
    { id: "pair", type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: .025 },
    { id: "local", type: "local-candidate", candidateType: "host", protocol: "udp", address: "PRIVATE_IP", usernameFragment: "PRIVATE_ICE" },
    { id: "remote", type: "remote-candidate", candidateType: "srflx", address: "PRIVATE_IP" },
    { id: "unused", type: "local-candidate", candidateType: "relay" },
    { id: "inbound", type: "inbound-rtp", kind: "video", bytesReceived: 999, framesDecoded: 12, framesDropped: 2, packetsLost: 1, jitter: .004, codecId: "codec" },
    { id: "codec", type: "codec", mimeType: "video/H264", sdpFmtpLine: "PRIVATE_SDP" },
  ];
  const result = summarizeRtcStats(new Map(rows.map(row => [row.id, row])));
  assert.equal(result.relayed, false);
  assert.equal(result.roundTripMs, 25);
  assert.equal(result.framesDecoded, 12);
  assert.equal(result.jitterMs, 4);
  assert.equal(result.codec, "H264");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|address|username|sdpFmtp/);
  rows[4].candidateType = "relay";
  assert.equal(summarizeRtcStats(new Map(rows.map(row => [row.id, row]))).relayed, true);
  assert.equal(summarizeRtcStats(new Map()).relayed, null);
});

test("diagnostic numeric fields reject malformed, infinite and negative values", () => {
  const { summarizeRtcStats } = runtime().load("live-diagnostics");
  const result = summarizeRtcStats(new Map([["bad", {
    type: "inbound-rtp", kind: "video", bytesReceived: Infinity, framesDecoded: -9,
    packetsLost: "PRIVATE", jitter: NaN,
  }]]));
  assert.equal(result.bytesReceived, 0);
  assert.equal(result.framesDecoded, 0);
  assert.equal(result.jitterMs, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|NaN|Infinity/);
});

test("optional unlock status backs off and stops automatic polling on explicit denial", () => {
  const { unlockStatusPollDelay: delay } = runtime().load("status-poll");
  assert.equal(delay({ failures: 0, enabled: true, helperReady: true }), 5000);
  assert.equal(delay({ failures: 0, enabled: false }), 30000);
  assert.equal(delay({ failures: 1, status: 503 }), 15000);
  assert.equal(delay({ failures: 2, status: 503 }), 30000);
  assert.equal(delay({ failures: 20, status: 503 }), 120000);
  assert.equal(delay({ failures: 1, status: 429 }), 60000);
  for (const status of [401, 403, 404, 410]) assert.equal(delay({ failures: 1, status }), null);
});

test("status polling never overlaps, is manually retryable, and aborts on disposal", async () => {
  const f = runtime();
  let release, count = 0, signal;
  const poll = f.load("status-poll").createStatusPoll(async received => {
    signal = received; count++;
    await new Promise(resolve => { release = resolve; });
    return 15000;
  });
  const first = poll.request();
  await flush(); void poll.request(); await f.advance(60000);
  assert.equal(count, 1);
  release(); await first;
  await f.advance(14999); assert.equal(count, 1);
  await f.advance(1); assert.equal(count, 2);
  poll.stop(); assert.equal(signal.aborted, true);
  release(); await flush(); await f.advance(60000);
  assert.equal(count, 2);
  assert.equal(f.timers.size, 0);
});

test("a denied status read stops its timer, but an explicit refresh can retry", async () => {
  const f = runtime(); let count = 0;
  const poll = f.load("status-poll").createStatusPoll(async () => { count++; return null; });
  await poll.request(); await f.advance(120000);
  assert.equal(count, 1);
  await poll.request(); assert.equal(count, 2);
  poll.stop();
});

test("a realtime refresh burst has one in-flight read and one trailing read", async () => {
  const f = runtime();
  let count = 0, active = 0, peak = 0, release;
  const refresh = f.load("coalesced-refresh").createCoalescedRefresh(async () => {
    count++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => { release = resolve; });
    active--;
  }, () => assert.fail("unexpected refresh error"));
  const first = refresh.request();
  await flush();
  for (let i = 0; i < 50; i++) void refresh.request();
  assert.equal(count, 1);
  release(); await first;
  await f.advance(250); assert.equal(count, 2);
  release(); await flush();
  assert.equal(peak, 1);
  refresh.stop(); assert.equal(f.timers.size, 0);
});

test("a hung refresh is bounded and an unmount cancels its transport without another read", async () => {
  const f = runtime(); let failures = 0, signal;
  const refresh = f.load("coalesced-refresh").createCoalescedRefresh(async received => {
    signal = received; await new Promise(() => {});
  }, () => { failures++; });
  void refresh.request(); await flush();
  await f.advance(12000);
  assert.equal(failures, 1); assert.equal(signal.aborted, true);
  void refresh.request(); await flush();
  refresh.stop(); assert.equal(signal.aborted, true);
  await f.advance(12000); assert.equal(failures, 1);
});
