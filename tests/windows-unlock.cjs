const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const root = 'src/';
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(root + file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, Error, Date, TextEncoder, crypto: crypto.webcrypto, btoa, atob, Uint8Array, AbortSignal,
  setInterval, clearInterval, ...globals });
  return exports;
}
const model = load('shared/windows-unlock.ts');
const client = load('lib/windows-unlock-client.ts', {
  '@/shared/windows-unlock': model, '@/integrations/supabase/client': { supabase: {} },
});
function control() {
  let now = 1000, timer = null, connected = true;
  const messages = [];
  class Clock extends Date { static now() { return now; } }
  const controller = load('lib/browser-unlock.ts', { '@/shared/windows-unlock': model }, {
    Date: Clock, setInterval: cb => { timer = cb; return 1; }, clearInterval: () => { timer = null; },
  }).createBrowserUnlock('session', 'grant', value => { if (!connected) return false; messages.push(value); return true; });
  const ticket = { requestId: crypto.randomUUID(), expiresAt: new Date(121000).toISOString() };
  const receipt = (phase, extra = {}) => controller.receive({ kind: 'unlock_status', session_id: 'session',
    authorization_id: 'grant', request_id: ticket.requestId, phase, ...extra });
  return { controller, ticket, messages, receipt,
    disconnect() { connected = false; }, advance(ms) { now += ms; timer?.(); } };
}
test('PIN validation preserves leading zeroes and rejects unsupported characters', () => {
  assert(model.validHelloPin('00001234')); assert(model.validHelloPin(' Ab1 '));
  assert(!model.validHelloPin('123')); assert(!model.validHelloPin('123\n')); assert(!model.validHelloPin('é123'));
  assert.equal(model.pinAssociatedData('ABC', 'DEF', 'GHI'), 'ConnectLive.WindowsHelloPin.v1\nabc\ndef\nghi');
});
test('browser envelope decrypts only with the enrolled private key and exact device/grant/key context', async () => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const device = { enabled: true, deviceId: crypto.randomUUID(), authorizationId: crypto.randomUUID(), keyId: crypto.randomUUID(),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  const pin = '00001234'; // Synthetic fixture, not a user's credential.
  const envelope = await client.sealHelloPin(pin, device);
  assert.equal(envelope.algorithm, 'RSA-OAEP-256+A256GCM');
  assert(!JSON.stringify(envelope).includes(`"${pin}"`));
  assert.equal(Buffer.from(envelope.wrappedKey, 'base64').length, 384);
  const key = crypto.privateDecrypt({ key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(envelope.wrappedKey, 'base64'));
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  const decrypt = aad => {
    const aes = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    aes.setAAD(Buffer.from(aad)); aes.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([aes.update(bytes.subarray(0, -16)), aes.final()]).toString();
  };
  assert.equal(decrypt(model.pinAssociatedData(device.deviceId, device.authorizationId, device.keyId)), pin);
  assert.throws(() => decrypt(model.pinAssociatedData(crypto.randomUUID(), device.authorizationId, device.keyId)));
  assert.throws(() => decrypt(model.pinAssociatedData(device.deviceId, crypto.randomUUID(), device.keyId)));
  key.fill(0);
});
test('unknown, cross-peer or mismatched receipts do not enable secure input', async () => {
  const e = control(); const begun = e.controller.begin(e.ticket);
  assert(!e.controller.input('keydown', { vk: 13 }));
  e.receipt('ready', { authorization_id: 'wrong' });
  e.receipt('ready', { session_id: 'wrong' });
  e.receipt('ready', { request_id: crypto.randomUUID() });
  assert.equal(e.controller.state().phase, 'starting');
  e.receipt('ready'); await begun;
  assert(e.controller.input('keydown', { vk: 13 }));
  assert.equal(e.messages.at(-1).kind, 'unlock_input');
  e.controller.cancel();
  assert(!e.controller.input('unicode_text', { text: 'synthetic' }));
});
test('saved PIN is requested once and stale readiness cannot permit another input', async () => {
  const e = control(); const begun = e.controller.begin(e.ticket); e.receipt('ready'); await begun;
  e.controller.useSavedPin(); e.receipt('ready'); e.receipt('starting');
  assert.equal(e.controller.state().phase, 'submitted');
  assert.throws(() => e.controller.useSavedPin());
  assert(!e.controller.input('unicode_text', { text: 'synthetic' }));
  assert.equal(e.messages.filter(m => m.kind === 'unlock_pin').length, 1);
  e.receipt('unlocked'); assert.equal(e.controller.state().phase, 'unlocked');
  e.controller.reset(); assert.equal(e.controller.state().phase, 'unlocked');
});
test('timeouts and connection failures cancel without credential retries or automatic resume', async () => {
  const e = control(); const begun = e.controller.begin(e.ticket);
  e.advance(6000); await assert.rejects(begun);
  assert.equal(e.controller.state().phase, 'blocked');
  const before = e.messages.length; e.receipt('ready'); e.advance(10000);
  assert.equal(e.messages.length, before);
  const next = control(); const pending = next.controller.begin(next.ticket); next.receipt('ready'); await pending;
  next.disconnect();
  assert(!next.controller.input('unicode_text', { text: 'synthetic' }));
  assert.equal(next.controller.state().phase, 'blocked');
});
test('native secure input and privileged service retain fail-closed source boundaries', () => {
  const read = path => fs.readFileSync('' + path, 'utf8');
  const transport = read('admin/src/Input/InputTransport.cs');
  assert(transport.includes('SensitiveSessions'));
  assert(transport.includes('if (IsSensitive(sessionId) && !AlwaysRest.Contains(kind)) return Task.CompletedTask;'));
  const pipe = read('agent/unlock-shared/UnlockPipe.cs');
  assert(pipe.includes('PIPE_REJECT_REMOTE_CLIENTS'));
  assert(pipe.includes('AssertProtected'));
  assert(pipe.includes('ServicePid()'));
  assert(pipe.includes('expectedPid <= 0 || id != expectedPid'));
  const input = read('agent/unlock/DesktopInput.cs');
  assert(input.includes('field.Current.IsPassword'));
  assert(input.includes('"LogonUI.exe"'));
  assert(input.includes('OnLockedDesktop'));
  const operation = read('agent/src/UnlockOperation.cs');
  assert(operation.includes('WindowsSession.Locked(WindowsSession.CurrentId) == false'));
  assert(operation.includes('Interlocked.Exchange(ref _pinConsumed, 1)'));
  assert(operation.includes('CryptographicOperations.ZeroMemory(pin)'));
  const api = read('agent/src/ApiClient.cs');
  assert(api.slice(api.indexOf('public async Task<bool> PostFrameAsync')).includes('UnlockOperation.Sensitive'));
});
