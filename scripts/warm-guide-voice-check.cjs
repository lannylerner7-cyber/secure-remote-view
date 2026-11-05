const assert = require("node:assert/strict");
const { test } = require("node:test");
const { warmGuideVoice, verifyStoredSpeech } = require("./warm-guide-voice.cjs");
const { fixture } = require("./test-support/guide-fixture.cjs");

test("a targeted warm checks the current reply and reads back both durable objects", async () => {
  const f = fixture();
  const requests = [];
  const log = [];
  const count = await warmGuideVoice(["https://guide.invalid", "--only", "support-thanks"], {
    fetcher: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.hostname === "guide.invalid") {
        const request = new Request(url, init);
        return url.pathname.endsWith("/answer") ? f.answerHandler({ request })
          : f.load("src/routes/api/public/guide/speech.ts").Route.server.handlers.POST({ request });
      }
      return f.fetcher(url, init);
    },
    log: (line) => log.push(line),
    wait: async () => { throw new Error("one reply needs no rate-limit delay"); },
  });
  assert.equal(count, 1);
  assert.equal(requests.length, 4);
  assert.deepEqual(Object.keys(JSON.parse(requests[1].init.body)).sort(), ["answerId", "textHash"]);
  assert.ok(requests[2].url.pathname.endsWith(".json"));
  assert.ok(requests[3].url.pathname.endsWith(".mp3"));
  assert.match(log[0], /persisted audio and captions verified/);
});

test("a URL alone cannot certify missing metadata, missing audio, or mismatched text", async () => {
  for (const failure of ["metadata", "audio", "old-text", "empty-audio", "temporary"]) {
    const f = fixture();
    const reply = await f.getReply("support-thanks");
    const speech = await f.speech(reply);
    const metadataUrl = speech.audio.url.replace(/\.mp3$/, ".json");
    if (failure === "metadata") f.state.store.delete(metadataUrl);
    if (failure === "audio") f.state.store.delete(speech.audio.url);
    if (failure === "old-text") {
      f.state.store.set(metadataUrl, { bytes: JSON.stringify({ ...speech, text: "Older wording." }), type: "application/json" });
    }
    if (failure === "empty-audio") f.state.store.set(speech.audio.url, { bytes: "", type: "audio/mpeg" });
    if (failure === "temporary") speech.warning = "Not persisted";
    await assert.rejects(verifyStoredSpeech(reply, speech, f.fetcher), undefined, failure);
  }
});

test("warm refuses non-approved IDs, secret-bearing URLs, and unknown flags before any request", async () => {
  for (const argv of [
    ["--only", "not-approved"],
    ["https://user:password@guide.invalid"],
    ["https://guide.invalid?key=sensitive"],
    ["--force"],
  ]) {
    let requests = 0;
    await assert.rejects(warmGuideVoice(argv, { fetcher: async () => { requests++; }, log: () => {} }));
    assert.equal(requests, 0);
  }
});

test("warming fails on stale prices/provider failures rather than reporting readiness", async () => {
  for (const status of [409, 429, 503]) {
    const lines = [];
    await assert.rejects(warmGuideVoice(["--only", "support-thanks"], {
      fetcher: async () => new Response("", { status }),
      log: (line) => lines.push(line),
    }), new RegExp(`HTTP ${status}`));
    assert.equal(lines.length, 0);
  }
});
