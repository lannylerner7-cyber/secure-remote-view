const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto').webcrypto;
const ts = createRequire(path.resolve('package.json'))('typescript');
let checks = 0, id = 0;
const timers = new Map();
const check = (value, name) => { assert(value, name); checks++; };
function load(name) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(name, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { module, exports: module.exports, crypto, TextEncoder,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: key => timers.delete(key),
  });
  return module.exports;
}
async function main() {
  const { devicePresence, runtimeDescription, watchReachable } = load('src/shared/agent-lifecycle.ts');
  const now = Date.parse('2026-11-03T12:00:00Z');
  const ago = seconds => new Date(now - seconds * 1000).toISOString();
  const device = { status: 'online', last_seen_at: ago(59) };
  check(devicePresence(device, now) === 'online', 'healthy 60-second legacy idle cadence is not stale at 30s');
  check(devicePresence({ ...device, last_seen_at: ago(80) }, now) === 'reconnecting', 'late check-in is not immediately offline');
  check(devicePresence({ ...device, last_seen_at: null }, now) === 'offline', 'missing heartbeat is unknown/offline');
  const runtime = { agent_state: 'running', agent_seen_at: ago(59), heartbeat_seconds: 60,
    startup_enabled: true, watch_seen_at: ago(10), detail_code: null };
  check(devicePresence(device, now, runtime) === 'online', 'new 60-second lease');
  check(devicePresence(device, now, { ...runtime, heartbeat_seconds: 5 }) === 'offline', 'active cadence expires sooner');
  check(devicePresence({ ...device, metadata: { agent_runtime_protocol: 0 } }, now,
    { ...runtime, agent_state: 'failed' }) === 'online', 'rollback to a legacy Agent uses its fresh legacy heartbeat');
  check(devicePresence(device, now, { ...runtime, agent_state: 'stopped' }) === 'stopped', 'Watch-backed stopped');
  check(devicePresence(device, now, { ...runtime, agent_state: 'stopped', watch_seen_at: ago(100) }) === 'offline', 'stale Watch cannot assert reachability');
  check(!watchReachable({ ...runtime, startup_enabled: false }, now), 'local startup opt-out');
  check(runtimeDescription({ ...runtime, agent_state: 'uninstalling' }, now).includes('completion unverified'), 'removal not mislabeled completed');
  const { createBrowserCurtain } = load('src/lib/browser-curtain.ts');
  const sent = []; let state, mode = 'control';
  const curtain = createBrowserCurtain('session', 'grant', value => { sent.push(value); return true; }, () => mode);
  curtain.onState(value => { state = value; });
  await assert.rejects(curtain.set(true)); checks++;
  curtain.permission(true, false);
  const on = curtain.set(true);
  check(state.active === false && state.pending, 'no optimistic on');
  const request = sent.at(-1);
  const receipt = (request, extra = {}) => ({ kind: 'action_status', session_id: 'session', authorization_id: 'grant',
    request_id: request.payload.request_id, action: request.kind, status: 'applied', active: true, ...extra });
  curtain.receive(receipt(request, { authorization_id: 'wrong' }));
  check(state.active === false, 'wrong grant receipt ignored');
  curtain.receive(receipt(request, { action: 'curtain_off' }));
  check(state.active === false, 'wrong action receipt ignored');
  curtain.receive(receipt(request));
  await on;
  check(state.active === true && !state.pending, 'application receipt confirms on');
  const tick = [...timers.entries()].find(([, timer]) => timer.delay === 1500);
  check(!!tick, 'renewal scheduled only after confirmation');
  timers.delete(tick[0]); tick[1].fn();
  const renewal = sent.at(-1);
  check(renewal.kind === 'curtain_renew', 'renewal is not a repeated on');
  const off = curtain.set(false);
  curtain.receive(receipt(renewal)); // Renewal was in flight when Off was requested.
  await Promise.resolve(); await Promise.resolve();
  check(![...timers.values()].some(timer => timer.delay === 1500), 'late renewal cannot restart Off lease');
  const offRequest = sent.findLast(value => value.kind === 'curtain_off');
  curtain.receive(receipt(offRequest, { active: false }));
  await off;
  check(state.active === false, 'off requires receipt');
  const retry = curtain.set(true);
  const latest = sent.at(-1);
  curtain.receive(receipt(latest)); await retry;
  curtain.receive({ kind: 'curtain_state', session_id: 'session', authorization_id: 'grant', active: false, reason: 'lease_expired' });
  check(state.active === false && timers.size === 0, 'Agent expiry cancels renewals');
  const pending = curtain.set(true);
  curtain.reset();
  await assert.rejects(pending); checks++;
  check(state.active === null && !state.supported && timers.size === 0, 'disconnect is unconfirmed, never fabricated off');
  curtain.dispose();
  console.log(`${checks} lifecycle/browser receipt checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
