// Pure UI data/selection checks and action-wiring contracts. No network traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..', '.');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, module: { exports }, Date, Map, Set,
    require: name => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    } });
  return exports;
}
const platform = load('src/shared/platform.ts');
const f = load('src/lib/access-filters.ts', { '@/shared/platform': platform });
let checks = 0;
function check(name, run) { run(); checks++; }
const now = Date.UTC(2026, 10, 3, 12);
const ago = days => new Date(now - days * 86400000).toISOString();
const make = (id, patch = {}) => ({
  id, device_id: id, display_name: `Device ${id}`, hostname: `HOST-${id}`,
  os: 'Windows 11', platform: 'windows', license_id: 'north',
  metadata: { agent_version: '1.10.1' }, status: 'online', last_seen_at: ago(0),
  ...patch,
});
const devices = [
  make('workstation', { display_name: 'Reception Workstation' }),
  make('offline', { license_id: 'south', metadata: { agent_version: '1.9.0' } }),
  make('tablet', { platform: 'android', os: 'Android 14', metadata: { agent_version: '0.3.0' } }),
  make('stopped'),
  make('unassigned', { license_id: null, hostname: null, metadata: null }),
  make('unread', { license_id: 'not-readable' }),
];
const states = { workstation: 'online', offline: 'offline', tablet: 'reconnecting',
  stopped: 'stopped', unassigned: 'offline', unread: 'offline' };
const sessions = [
  { id: 's1', device_id: 'workstation', state: 'active', created_at: ago(0.1) },
  { id: 's2', device_id: 'offline', state: 'ended', created_at: ago(3) },
  { id: 's3', device_id: 'tablet', state: 'paused', created_at: ago(8) },
  { id: 's4', device_id: 'stopped', state: 'ended', created_at: ago(-1) },
  { id: 's5', device_id: 'unread', state: 'ended', created_at: 'invalid' },
];
const ctx = {
  presenceOf: d => states[d.id], sessions, now,
  companies: { north: 'North Company', south: 'South Company' },
  latestVersions: { agent: '1.10.1', android: '0.3.0' },
};
const ids = list => Array.from(list, d => d.id);
const plain = value => JSON.parse(JSON.stringify(value));
check('every sidebar group has a unique stable id', () => {
  const groups = Array.from(f.ACCESS_GROUPS, g => g.id);
  assert.equal(new Set(groups).size, groups.length);
  for (const id of ['company', 'os', 'online', 'updates', 'connected', 'recent', 'offline', 'stopped'])
    assert(groups.includes(id));
});
check('real group counts are distinct', () => {
  assert.deepEqual(plain(f.countAccessGroups(devices, ctx)), {
    company: 6, os: 6, online: 1, updates: 1, connected: 2, recent: 2, offline: 3, stopped: 1,
  });
});
check('empty list has zero counts', () => {
  assert(Object.values(f.countAccessGroups([], ctx)).every(n => n === 0));
});
for (const [group, expected] of [
  ['online', ['workstation']], ['updates', ['offline']],
  ['connected', ['workstation', 'tablet']], ['recent', ['workstation', 'offline']],
  ['offline', ['offline', 'unassigned', 'unread']], ['stopped', ['stopped']],
]) check(`filter ${group}`, () => assert.deepEqual(ids(f.filterAccessDevices(devices, group, '', ctx)), expected));
check('all-device views include each device once', () => {
  for (const g of ['company', 'os']) assert.deepEqual(ids(f.filterAccessDevices(devices, g, '', ctx)), ids(devices));
});
check('multi-word search spans device and company fields', () => {
  assert.deepEqual(ids(f.filterAccessDevices(devices, 'company', '  RECEPTION north  ', ctx)), ['workstation']);
});
check('hostname search', () => assert(f.deviceMatchesSearch(devices[0], 'host-workstation', ctx.companies)));
check('OS search', () => assert.deepEqual(ids(f.filterAccessDevices(devices, 'os', 'android', ctx)), ['tablet']));
check('version search', () => assert.deepEqual(ids(f.filterAccessDevices(devices, 'company', '1.9.0', ctx)), ['offline']));
check('search terms are ANDed', () => assert(!f.deviceMatchesSearch(devices[0], 'reception south', ctx.companies)));
check('search does not override active group', () => assert.equal(f.filterAccessDevices(devices, 'online', 'offline', ctx).length, 0));
check('search has a true no-results state', () => assert.equal(f.filterAccessDevices(devices, 'company', 'not-a-real-device-zz', ctx).length, 0));
check('missing metadata stays safe', () => assert.equal(f.agentVersionOf(devices[4]), undefined));
check('malformed version is not accepted', () => assert.equal(f.agentVersionOf(make('bad', { metadata: { agent_version: 123 } })), undefined));
check('unknown release cannot invent an update', () => assert.equal(f.hasDeviceUpdate(devices[1], { agent: null, android: null }), false));
check('platform-specific update channel', () => assert.equal(f.hasDeviceUpdate(devices[2], { agent: '99.0.0', android: '0.3.0' }), false));
check('unassigned differs from unread company', () => {
  assert.equal(f.companyLabel(devices[4], ctx.companies), f.UNASSIGNED_COMPANY);
  assert.equal(f.companyLabel(devices[5], ctx.companies), f.COMPANY_UNAVAILABLE);
});
check('company loading is not reported as unassigned', () =>
  assert.equal(f.companyLabel(devices[0], {}, false), f.COMPANY_UNAVAILABLE));
check('blank company is explicitly unassigned', () =>
  assert.equal(f.companyLabel(devices[0], { north: '  ' }), f.UNASSIGNED_COMPANY));
check('future sessions do not become recent access', () =>
  assert.equal(f.isRecentlyAccessed(devices[3], sessions, now), false));
check('invalid timestamps do not become recent access', () =>
  assert.equal(f.isRecentlyAccessed(devices[5], sessions, now), false));
check('active and paused are live but ended is not', () => {
  assert.equal(f.hasLiveSession(devices[0], sessions), true);
  assert.equal(f.hasLiveSession(devices[2], sessions), true);
  assert.equal(f.hasLiveSession(devices[1], sessions), false);
});
check('only online/reconnecting devices offer Connect', () => {
  for (const state of ['online', 'reconnecting']) assert.equal(f.isConnectablePresence(state), true);
  for (const state of ['offline', 'stopped', undefined]) assert.equal(f.isConnectablePresence(state), false);
});
check('unavailable Connect explains recovery rather than promising a connection', () => {
  assert.equal(f.notConnectableReason('online'), null);
  assert.equal(f.notConnectableReason('reconnecting'), null);
  assert.match(f.notConnectableReason('stopped'), /relaunch.*More/);
  assert.match(f.notConnectableReason('offline'), /offline/);
});
check('company groups contain all devices with honest fallbacks last', () => {
  const sections = f.sectionAccessDevices(devices, 'company', ctx);
  assert.deepEqual(Array.from(sections, s => s.label),
    ['North Company', 'South Company', f.UNASSIGNED_COMPANY, f.COMPANY_UNAVAILABLE]);
  assert.equal(sections.reduce((n, s) => n + s.devices.length, 0), devices.length);
});
check('OS groups are actual platforms', () =>
  assert.deepEqual(Array.from(f.sectionAccessDevices(devices, 'os', ctx), s => s.label), ['Android', 'Windows']));
check('other views do not invent headings', () =>
  assert.equal(f.sectionAccessDevices(devices, 'offline', ctx)[0].label, null));
check('safe selection retains identity when unchanged', () => {
  const selected = new Set(['workstation']);
  assert.equal(f.pruneSelection(selected, ids(devices)), selected);
});
check('hidden selections are removed without mutating input', () => {
  const selected = new Set(['workstation', 'offline']);
  assert.deepEqual([...f.pruneSelection(selected, ['workstation'])], ['workstation']);
  assert.equal(selected.size, 2);
});
check('zero matches clears all targets', () =>
  assert.equal(f.pruneSelection(new Set(['workstation']), []).size, 0));

const route = fs.readFileSync(path.join(root, 'src/routes/_authenticated/console.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'src/components/console/AccessWorkspace.tsx'), 'utf8');
check('row and toolbar share the same presence eligibility rule', () =>
  assert((workspace.match(/isConnectablePresence\(/g) || []).length >= 2));
check('Access is the default while deep-link tabs remain supported', () => {
  assert.match(route, /search\.tab \?\? "devices"/);
  assert.match(route, /NAV_VALUES/);
});
for (const [prop, handler] of [
  ['onConnect', 'connectDevice'], ['onBulkEnd', 'bulkEndSessions'], ['onBulkRestart', 'bulkRestartAgent'],
]) check(`existing ${handler} stays wired`, () =>
  assert.match(route, new RegExp(`${prop}=\\{${handler}\\}`)));
check('power commands still use their existing handler', () =>
  assert.match(route, /onPower=\{\(d, kind\) => queuePower\(d, kind\)\}/));
check('pair dialog remains real and accessible', () => {
  assert.match(route, /<DevicePairingDialog open=\{pairingOpen\}/);
  assert.match(route, /onPair=\{\(\) => setPairingOpen\(true\)\}/);
});
check('viewer and its action rail remain in the real console', () => {
  assert.match(route, /<RemoteDisplayFrame/);
  assert.match(route, /id="viewer-action-rail"/);
  for (const label of ['Close viewer', 'Reconnect viewer', 'Send clipboard', 'Record session', 'Pause viewer', 'Privacy curtain', 'End session', 'Revoke device access'])
    assert(route.includes(label), label);
});
check('search and selection have accessible labels', () => {
  assert.match(workspace, /Select all visible devices/);
  assert.match(workspace, /Search devices/);
  assert.match(workspace, /aria-label=\{`Select \$\{d.display_name\}`\}/);
});
check('unresolved and non-staff roles cannot mutate devices', () => {
  const expression = route.match(/const canMutate = ([^;]+);/)?.[1];
  assert(expression);
  for (const role of [null, 'viewer', 'customer', undefined])
    assert.equal(vm.runInNewContext(expression, { role }), false);
  for (const role of ['super_admin', 'admin', 'technician'])
    assert.equal(vm.runInNewContext(expression, { role }), true);
});
check('pairing follows the database admin/super-admin boundary', () =>
  assert.match(route, /canPair=\{isAdmin\}/));
check('downloads use the actual in-app portal', () => {
  assert.match(workspace, /"\/public\/agent\/login"/);
  assert.doesNotMatch(workspace, /https:\/\/www\.connectliveagent\.com/);
});
check('expected-device install links use the same real portal', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/console/ExpectedDevicesPanel.tsx'), 'utf8');
  assert.match(source, /"\/public\/agent\/login"/);
  assert.doesNotMatch(source, /#download/);
});
check('company reads exclude billing/contact fields', () => assert.match(workspace, /\.select\("id, company"\)/));
check('recent-history limitation is disclosed', () => assert.match(workspace, /RECENT_SESSION_WINDOW/));
check('new menus do not contain dummy ScreenConnect actions', () => {
  for (const label of ['Run Tool', 'Create Session Group']) assert(!workspace.includes(label));
});
console.log(`${checks} console filter, selection, role-safe action-wiring and navigation checks passed. No network or device traffic.`);
