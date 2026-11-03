const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = createRequire(path.resolve('package.json'))('typescript');
const crypto = require('node:crypto').webcrypto;
const timers = new Map();
let timerId = 0;
function load(file) {
  const module = { exports: {} };
  const localValues = new Map();
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: name => name === './browser-curtain' ? load('src/lib/browser-curtain.ts') : require(name),
    crypto, TextEncoder,
    localStorage: { getItem: key => localValues.get(key) ?? null, setItem: (key, value) => localValues.set(key, value) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  return module.exports;
}
async function main() {
  const { getWebClientId, isAdminClientId } = load('src/shared/signaling-identity.ts');
  const browserId = getWebClientId();
  assert(isAdminClientId(browserId) && browserId.startsWith('web-'));
  assert.equal(getWebClientId(), browserId, 'the real browser generator preserves its stored identity');
  assert(!isAdminClientId('web-value\n'));
  assert(!isAdminClientId('a'.repeat(65)));
  const fixtureArgument = process.argv.indexOf('--write-signaling-fixture');
  if (fixtureArgument !== -1) fs.writeFileSync(process.argv[fixtureArgument + 1], JSON.stringify({
    kind: 'offer', admin_client_id: browserId,
    payload: { type: 'offer', sdp: 'test-fixture-only', peer_id: crypto.randomUUID() },
  }));
  const { createBrowserActions } = load('src/lib/browser-actions.ts');
  const { videoSessionStatus } = load('src/lib/video-session-status.ts');
  const { usesLegacyActions, legacyMonitorMayBeDelivered } = load('src/shared/legacy-monitor.ts');
  assert(usesLegacyActions('legacy', {}));
  assert(!usesLegacyActions('legacy', { browser_video: 1 }));
  assert(!usesLegacyActions('video', {}));
  assert(!usesLegacyActions(undefined, {}));
  const queued = { kind: 'switch_monitor', payload: { protocol: 'legacy-monitor-v1', session_id: 's', authorization_id: 'g' } };
  const authority = { id: 'g', revokedAt: null, capabilities: { view: true } };
  assert(legacyMonitorMayBeDelivered(queued, authority, [{ id: 's', state: 'active', media_mode: 'legacy' }]));
  assert(!legacyMonitorMayBeDelivered(queued, { ...authority, revokedAt: 'now' }, [{ id: 's', state: 'active', media_mode: 'legacy' }]));
  assert(!legacyMonitorMayBeDelivered(queued, authority, [{ id: 's', state: 'ended', media_mode: 'legacy' }]));
  assert(!legacyMonitorMayBeDelivered({ ...queued, kind: 'reboot' }, authority, [{ id: 's', state: 'active', media_mode: 'legacy' }]));
  const { tagPeerSignal, isCurrentPeerSignal } = load('src/lib/peer-signals.ts');
  const tagged = tagPeerSignal('new-viewer', { peer_id: 'old-viewer', type: 'offer', sdp: 'test' });
  assert.equal(tagged.peer_id, 'new-viewer');
  assert.equal(tagged.sdp, 'test');
  assert(isCurrentPeerSignal('new-viewer', true, tagged));
  assert(!isCurrentPeerSignal('new-viewer', true, { peer_id: 'old-viewer' }));
  assert(!isCurrentPeerSignal('new-viewer', true, {}));
  assert(isCurrentPeerSignal('new-viewer', false, {}), 'old Agents remain supported only in legacy mode');
  const sent = [];
  let active = true, overloads = 0;
  const dc = { readyState: 'open', bufferedAmount: 0, send: data => sent.push(JSON.parse(data)) };
  const actions = createBrowserActions('session', 'grant', () => dc, () => active, () => overloads++);
  const report = value => actions.receive(JSON.stringify(value));
  report({ kind: 'permission_status', session_id: 'other', authorization_id: 'grant', mode: 'control' });
  report({ kind: 'permission_status', session_id: 'session', authorization_id: 'wrong', mode: 'control' });
  assert.equal(actions.mode(), null, 'no mode from another session or authorization');
  report({ kind: 'permission_status', session_id: 'session', authorization_id: 'grant', mode: 'view' });
  assert.equal(actions.mode(), 'view');
  const first = actions.selectMonitor('DISPLAY1');
  await assert.rejects(actions.selectMonitor('DISPLAY2'), /already awaiting/);
  const id = sent.at(-1).payload.request_id;
  report({ kind: 'action_status', session_id: 'other', action: 'switch_monitor', request_id: id, status: 'applied' });
  assert.equal(timers.size, 1, 'foreign acknowledgement ignored');
  report({ kind: 'action_status', session_id: 'session', action: 'switch_monitor', request_id: id, status: 'applied' });
  await first;
  assert.equal(timers.size, 0);
  const rejected = actions.selectMonitor('DISPLAY2');
  report({ kind: 'action_status', session_id: 'session', action: 'switch_monitor',
    request_id: sent.at(-1).payload.request_id, status: 'rejected' });
  await assert.rejects(rejected, /Agent rejected/);
  const timed = actions.selectMonitor('DISPLAY2');
  for (const fn of timers.values()) fn();
  timers.clear();
  await assert.rejects(timed, /result is unknown/);
  const lost = actions.selectMonitor('DISPLAY2');
  actions.reset();
  await assert.rejects(lost, /disconnected/);
  assert.equal(actions.mode(), null);
  dc.bufferedAmount = 65537;
  assert.equal(actions.send({ kind: 'keydown' }), false);
  assert.equal(overloads, 1);
  dc.bufferedAmount = 0;
  active = false;
  report({ kind: 'permission_status', session_id: 'session', authorization_id: 'grant', mode: 'control' });
  assert.equal(actions.mode(), null);
  assert.equal(actions.send({ kind: 'keydown' }), false);
  actions.dispose();
  const base = { sessionState: 'active', supported: true, viewerPaused: false,
    deviceOnline: true, rtcState: 'connected', decoding: true, attemptAgeMs: 10000 };
  for (const [change, expected] of [
    [{}, 'live'], [{ sessionState: 'invited' }, 'waiting'], [{ supported: false }, 'unsupported'],
    [{ rtcState: 'failed' }, 'disconnected'], [{ rtcState: 'superseded' }, 'disconnected'],
    [{ deviceOnline: false }, 'disconnected'], [{ viewerPaused: true }, 'paused'],
    [{ decoding: false }, 'stalled'], [{ decoding: false, attemptAgeMs: 1000 }, 'connecting'],
    [{ sessionState: 'ended' }, 'ended'], [{ sessionState: 'paused' }, 'paused'],
  ]) assert.equal(videoSessionStatus({ ...base, ...change }).key, expected);
  const consoleSource = fs.readFileSync('src/routes/_authenticated/console.tsx', 'utf8');
  assert(consoleSource.includes('currentLiveSession?.media_mode === "legacy" && !videoDecoding'),
    'JPEG is opt-in only for known legacy sessions');
  assert(!consoleSource.includes('"curtain_on"'), 'ordinary browser control never engages a curtain');
  assert(consoleSource.includes('if (sentRealtime) return;'), 'discrete input is not duplicated through the database');
  assert(consoleSource.includes('live?.sessionId !== sessionId'), 'stale callbacks cannot send to a different peer');
  const rtc = fs.readFileSync('src/lib/webrtc-live.ts', 'utf8');
  assert(rtc.includes('payload: tagPeerSignal(peerId, payload)'), 'all queued signaling is peer-instance tagged');
  assert(rtc.includes('payload: tagPeerSignal(peerId, {})'), 'final bye retains its old viewer identity');
  assert(rtc.includes('signals-${sessionId}-${webClientId}-${peerId}'), 'replacement subscriptions never reuse old channel identity');
  const native = fs.readFileSync('agent/src/WebRtcSession.cs', 'utf8');
  const bye = native.split('case "bye":')[1].split('public void Close()')[0];
  assert(bye.includes('_signalBinding.TryRelease') && bye.includes('TearDownPeer()'));
  assert(!bye.includes('Close();') && !bye.includes('_cts.Cancel') && !bye.includes('_inputPermission.Revoke'),
    'a viewer bye must not terminate session permission or signaling');
  const teardown = native.split('private void TearDownPeer()')[1].split('private void DisposeH264')[0];
  assert(teardown.includes('oldPermission?.Revoke()') && !teardown.includes('_inputPermission.Revoke'),
    'peer teardown revokes only peer-local callbacks');
  assert(native.includes('peer_id = boundPeerId') && native.includes('peer_id = incomingPeerId'),
    'Agent ICE and answers echo the bound viewer instance');
  const railClass = consoleSource.match(/const actionButtonClass = "([^"]+)";/)?.[1];
  assert(railClass, 'viewer actions define a dark-surface style');
  const { twMerge } = createRequire(path.resolve('package.json'))('tailwind-merge');
  const merged = twMerge('border border-input bg-background hover:bg-accent hover:text-accent-foreground', railClass);
  assert(!merged.includes('bg-background') && merged.includes('bg-transparent') && merged.includes('text-white/80'),
    'outline actions cannot inherit a white-on-white background in the dark viewer');
  console.log('PASS: correlated action receipts, permission binding, timeouts, congestion, disconnects, video states and no-JPEG/input-duplication guards.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
