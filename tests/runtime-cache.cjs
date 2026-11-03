const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = createRequire(path.resolve('package.json'))('typescript');
function load(file, overrides = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, module: { exports }, Request, Response, Headers, URL, AbortController,
    setTimeout, clearTimeout, console: { warn() {} }, ...overrides });
  return exports;
}
function worker() {
  let now = 1000000, calls = 0, failed = false;
  const pricing = load('src/lib/pricing.server.ts', {
    Date: class extends Date { static now() { return now; } },
    fetch: async url => {
      calls++;
      await Promise.resolve();
      if (failed) throw new Error('Simulated provider outage');
      return { ok: true, json: async () => ({ data: { amount: url.includes('/BTC-') ? '90000' : '1' } }) };
    },
  });
  return { pricing, calls: () => calls, advance: ms => { now += ms; }, fail: value => { failed = value; } };
}
async function main() {
  let checks = 0;
  const a = worker(), b = worker();
  const results = await Promise.all(Array.from({ length: 50 }, () => a.pricing.getUsdToCoinRates()));
  assert.equal(a.calls(), 3, '50 requests share one three-pair fetch'); checks++;
  assert(results.every(r => r === results[0])); checks++;
  assert(Object.isFrozen(results[0])); checks++;
  await a.pricing.getUsdToCoinRates();
  assert.equal(a.calls(), 3, 'fresh value cached'); checks++;
  await b.pricing.getUsdToCoinRates();
  assert.equal(b.calls(), 3, 'each replica has its own public-rate cache'); checks++;
  a.advance(61000); a.fail(true);
  assert.equal((await a.pricing.getUsdToCoinRates()).BTC, 90000, 'bounded stale fallback'); checks++;
  const outageCalls = a.calls();
  await Promise.all(Array.from({ length: 50 }, () => a.pricing.getUsdToCoinRates()));
  assert.equal(a.calls(), outageCalls, 'provider failures have bounded retry backoff'); checks++;
  a.advance(250000);
  await assert.rejects(a.pricing.getUsdToCoinRates(), /temporarily unavailable/); checks++;
  const exhaustedCalls = a.calls();
  await assert.rejects(a.pricing.getUsdToCoinRates(), /temporarily unavailable/);
  assert.equal(a.calls(), exhaustedCalls); checks++;
  a.advance(11000); a.fail(false);
  assert.equal((await a.pricing.getUsdToCoinRates()).BTC, 90000, 'provider recovery'); checks++;

  const { applyResponseCachePolicy: policy } = load('src/lib/response-cache-policy.ts');
  for (const route of ['/health', '/api/public/agent/watch', '/api/public/agent/release',
    '/api/public/agent/stream', '/_serverFn/example', '/console', '/payments']) {
    const original = new Response('ok', { headers: { 'Cache-Control': 'public,max-age=3600', ETag: 'old' } });
    const r = policy(new Request(`https://example.test${route}`), original);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store, no-transform');
    assert.equal(r.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
    assert.equal(r.headers.get('ETag'), null);
    assert.equal(await r.text(), 'ok');
    checks++;
  }
  const asset = new Response('image', { headers: { 'Cache-Control': 'public,max-age=3600' } });
  assert.equal(policy(new Request('https://example.test/assets/logo.png'), asset), asset); checks++;
  const auth = policy(new Request('https://example.test/private', { headers: { Authorization: 'Bearer fixture' } }), new Response('private'));
  assert.match(auth.headers.get('Cache-Control'), /no-store/); checks++;
  const login = policy(new Request('https://example.test/login'), new Response('login', { headers: { 'Set-Cookie': 'fixture=1' } }));
  assert.match(login.headers.get('Cache-Control'), /no-store/); checks++;
  const streaming = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: ready\n\n')); c.close(); } }),
    { headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } });
  const stream = policy(new Request('https://example.test/api/public/agent/stream'), streaming);
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  assert.equal(await stream.text(), 'event: ready\n\n'); checks++;
  console.log(`${checks} runtime cache/replica-isolation/streaming-header checks passed. No provider or production traffic.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
