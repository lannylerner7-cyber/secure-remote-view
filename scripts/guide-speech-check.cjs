const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fixture, providerResult, TEST_KEY } = require("./test-support/guide-fixture.cjs");
const inputFor = (reply) => ({ answerId: reply.id, textHash: reply.textHash });

test("provider selection is explicit, fails closed, and preserves the existing default", () => {
  const f = fixture();
  const { resolveGuideSpeechProvider: resolve } = f.load("src/lib/guide-speech-provider.server.ts");
  assert.equal(resolve({}), "cache-only");
  assert.equal(resolve({ REPL_ID: "test" }), "replit");
  assert.equal(resolve({ ELEVENLABS_API_KEY: TEST_KEY }), "elevenlabs");
  assert.equal(resolve({ REPL_ID: "test", ELEVENLABS_API_KEY: TEST_KEY }), "replit");
  assert.equal(resolve({ GUIDE_SPEECH_PROVIDER: "elevenlabs", REPL_ID: "test" }), "elevenlabs");
  assert.equal(resolve({ GUIDE_SPEECH_PROVIDER: "cache-only", ELEVENLABS_API_KEY: TEST_KEY }), "cache-only");
  assert.throws(() => resolve({ GUIDE_SPEECH_PROVIDER: TEST_KEY }), (error) => error.status === 503);
  assert.ok(!f.state.logs.join("").includes(TEST_KEY));
});

test("an edited approved answer creates a new durable clip, rejects its old hash, and survives restart", async () => {
  const f = fixture({ env: { GUIDE_SPEECH_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: TEST_KEY, REPL_ID: "leftover-test-id" } });
  const before = await f.getReply("support-thanks");
  const first = await f.post(inputFor(before));
  assert.equal(first.status, 200);
  const oldClip = await first.json();
  f.knowledge.knowledgeEntries.find((entry) => entry.id === before.id).answer += " Please ask if you need anything else.";
  const after = await f.getReply(before.id);
  assert.notEqual(after.textHash, before.textHash);
  const stale = await f.post(inputFor(before));
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed/);
  assert.equal(f.state.calls.length, 1, "stale request must not reach the provider or old memory cache");
  const fresh = await f.post(inputFor(after));
  assert.equal(fresh.status, 200);
  const clip = await fresh.json();
  assert.equal(clip.text, after.text);
  assert.equal(clip.words.map((word) => word.text).join(" "), after.text);
  assert.notEqual(clip.audio.url, oldClip.audio.url);
  assert.equal(f.state.calls.length, 2);
  assert.equal(f.state.uploads.length, 4);
  assert.equal(f.state.connectorLoads, 0, "explicit direct mode must never touch managed identity");
  const call = f.state.calls[1];
  assert.match(call.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/[^/]+\/with-timestamps\?/);
  assert.equal(call.init.headers["xi-api-key"], TEST_KEY);
  assert.equal(call.init.redirect, "error");
  assert.equal(JSON.parse(call.init.body).text, after.text);
  assert.ok(!JSON.stringify(clip).includes(TEST_KEY));
  const restarted = fixture({ env: {}, store: f.state.store });
  restarted.knowledge.knowledgeEntries.find((entry) => entry.id === after.id).answer = after.text;
  const persisted = await restarted.post(inputFor(after));
  assert.equal(persisted.status, 200);
  assert.deepEqual(await persisted.json(), clip);
  assert.equal(restarted.state.calls.length, 0, "persistent hits must work without any provider key");
});

test("only approved IDs/current hashes reach speech; client-supplied text is rejected", async () => {
  const f = fixture();
  const approved = await f.getReply("support-thanks");
  for (const extra of [{ text: "unapproved input" }, { voiceId: "other" }, { provider: "replit" }]) {
    assert.equal((await f.post({ ...inputFor(approved), ...extra })).status, 400);
  }
  assert.equal((await f.post({ answerId: "not-approved", textHash: "a".repeat(64) })).status, 404);
  assert.equal((await f.post({ answerId: approved.id, textHash: "b".repeat(64) })).status, 409);
  assert.equal((await f.post(inputFor(approved), { Origin: "https://other.invalid" })).status, 403);
  assert.equal((await f.post(inputFor(approved), { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await f.post(inputFor(approved), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await f.post({ ...inputFor(approved), text: "a".repeat(3000) })).status, 413);
  assert.equal(f.state.calls.length, 0);
});

test("a live-price hash is rechecked before even a cached clip can be returned", async () => {
  const f = fixture();
  const oldPrice = await f.getReply("plans-list");
  assert.equal((await f.post(inputFor(oldPrice))).status, 200);
  f.state.catalog[0].amount_usd = 12; // Isolated fixture only; no database exists in this test.
  const latest = await f.getReply("plans-list");
  assert.notEqual(latest.textHash, oldPrice.textHash);
  assert.equal((await f.post(inputFor(oldPrice))).status, 409);
  assert.equal(f.state.calls.length, 1);
  const response = await f.post(inputFor(latest));
  assert.equal(response.status, 200);
  assert.match((await response.json()).text, /12 US dollars/);
  f.state.catalogError = true;
  assert.equal((await f.post(inputFor(latest))).status, 409);
  const outage = await f.getReply("plans-list");
  assert.equal(outage.id, "catalog-unavailable");
  assert.equal(outage.source, "unverified");
  assert.match(outage.text, /can't confirm current prices/);
  assert.doesNotMatch(outage.text, /12 US dollars/);
});

test("managed Replit mode still generates without a standalone key", async () => {
  const f = fixture({ env: { REPL_ID: "test-replit" } });
  const response = await f.post(inputFor(await f.getReply("support-thanks")));
  assert.equal(response.status, 200);
  assert.equal(f.state.connectorLoads, 1);
  assert.equal(f.state.calls[0].connector, true);
  assert.equal(f.state.calls[0].init.headers["xi-api-key"], undefined);
});

for (const env of [
  {}, { GUIDE_SPEECH_PROVIDER: "elevenlabs" }, { GUIDE_SPEECH_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: " " },
  { GUIDE_SPEECH_PROVIDER: "replit" }, { GUIDE_SPEECH_PROVIDER: "cache-only", ELEVENLABS_API_KEY: TEST_KEY },
]) {
  test(`missing/disabled provider leaves written answers intact: ${JSON.stringify({ ...env, ELEVENLABS_API_KEY: !!env.ELEVENLABS_API_KEY })}`, async () => {
    const f = fixture({ env });
    const reply = await f.getReply("support-thanks");
    const response = await f.post(inputFor(reply));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /written answer/);
    const textResponse = await f.answerHandler({ request: f.request({ question: "thanks" }, {}, "answer") });
    assert.equal((await textResponse.json()).text, reply.text);
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.uploads.length, 0);
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`provider HTTP ${status} is sanitized and does not fall back to another account`, async () => {
    const f = fixture();
    f.state.provider = async () => new Response(`provider detail ${TEST_KEY}`, { status });
    const reply = await f.getReply("support-thanks");
    const response = await f.post(inputFor(reply));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /read every word/);
    assert.ok(!JSON.stringify(body).includes(TEST_KEY));
    assert.ok(!f.state.logs.join("").includes(TEST_KEY));
    assert.equal(f.state.connectorLoads, 0);
    assert.equal(f.state.uploads.length, 0);
    assert.equal((await f.getReply(reply.id)).text, reply.text);
  });
}

test("transport timeouts are sanitized, retain text, and release the in-flight slot for retry", async () => {
  const f = fixture();
  const reply = await f.getReply("support-thanks");
  f.state.provider = async () => { throw new Error(`timeout ${TEST_KEY}`); };
  const response = await f.post(inputFor(reply));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /read every word/);
  assert.ok(!f.state.logs.join("").includes(TEST_KEY));
  f.state.provider = async (text) => Response.json(providerResult(text));
  assert.equal((await f.post(inputFor(reply))).status, 200);
});

for (const [name, responseFor] of [
  ["invalid JSON", () => new Response("not json")],
  ["null JSON", () => Response.json(null)],
  ["empty audio", (text) => Response.json({ ...providerResult(text), audio_base64: "" })],
  ["non-audio bytes", (text) => Response.json({ ...providerResult(text), audio_base64: Buffer.from("not audio").toString("base64") })],
  ["incorrect alignment", (text) => Response.json({ ...providerResult(text), alignment: providerResult("other wording").alignment })],
]) {
  test(`${name} never becomes a persisted clip`, async () => {
    const f = fixture();
    f.state.provider = async (text) => responseFor(text);
    const response = await f.post(inputFor(await f.getReply("support-thanks")));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /written answer/);
    assert.equal(f.state.uploads.length, 0);
  });
}

for (const suffix of [".mp3", ".json"]) {
  test(`failed ${suffix} upload returns real temporary audio, warns, and can retry persistence`, async () => {
    const f = fixture();
    f.state.failUpload = suffix;
    const reply = await f.getReply("support-thanks");
    const response = await f.post(inputFor(reply));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.audio.base64);
    assert.equal(body.audio.url, undefined);
    assert.match(body.warning, /couldn't be saved/);
    assert.equal(body.text, reply.text);
    assert.ok(f.state.logs.some((line) => line.includes("voice_cache_write_failed")));
    if (suffix === ".mp3") assert.equal(f.state.uploads.length, 1, "metadata cannot precede its audio");
    f.state.failUpload = null;
    const retried = await f.post(inputFor(reply));
    assert.ok((await retried.json()).audio.url, "failed persistence must not be remembered as a durable hit");
  });
}

test("same-hash requests coalesce and the three-generation concurrency limit remains", async () => {
  const f = fixture();
  const replies = await Promise.all(["support-thanks", "greeting", "unknown", "catalog-unavailable"].map(f.getReply));
  const release = [];
  f.state.provider = (text) => new Promise((resolve) => release.push(() => resolve(Response.json(providerResult(text)))));
  const jobs = replies.slice(0, 3).map((reply) => f.post(inputFor(reply)));
  const duplicate = f.post(inputFor(replies[0]));
  await new Promise(setImmediate);
  assert.equal(f.state.calls.length, 3);
  assert.equal((await f.post(inputFor(replies[3]))).status, 429);
  release.forEach((resolve) => resolve());
  for (const response of await Promise.all([...jobs, duplicate])) assert.equal(response.status, 200);
  assert.equal(f.state.calls.length, 3);
});

test("40 new generations per hour stay bounded, while cache hits and window reset work", async () => {
  const f = fixture();
  const entry = f.knowledge.knowledgeEntries.find((item) => item.id === "support-thanks");
  const first = await f.getReply(entry.id);
  await f.speech(first);
  for (let i = 1; i < 40; i++) {
    entry.answer = `Approved fixture wording number ${i}.`;
    await f.speech(await f.getReply(entry.id));
  }
  assert.equal(f.state.calls.length, 40);
  assert.ok((await f.speech(first)).audio.url);
  entry.answer = "Another approved fixture revision.";
  const last = await f.getReply(entry.id);
  await assert.rejects(f.speech(last), (error) => error.status === 429);
  f.state.now += 3_600_001;
  assert.ok((await f.speech(last)).audio.url);
  assert.equal(f.state.calls.length, 41);
});

test("public request limits still apply to cached speech and written answers", async () => {
  const f = fixture();
  const reply = await f.getReply("support-thanks");
  for (let i = 0; i < 20; i++) assert.equal((await f.post(inputFor(reply))).status, 200);
  const limited = await f.post(inputFor(reply));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(f.state.calls.length, 1);
  for (let i = 0; i < 30; i++) {
    assert.equal((await f.answerHandler({ request: f.request({ question: "thanks" }, {}, "answer") })).status, 200);
  }
  assert.equal((await f.answerHandler({ request: f.request({ question: "thanks" }, {}, "answer") })).status, 429);
});
