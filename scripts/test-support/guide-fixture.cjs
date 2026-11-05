const assert = require("node:assert/strict");
const { createGuideLoader, approvedKnowledge } = require("./guide-loader.cjs");
const TEST_KEY = "synthetic-elevenlabs-test-key";
const AUDIO = Buffer.from("ID3synthetic-test-only-audio");

function providerResult(text) {
  return {
    audio_base64: AUDIO.toString("base64"),
    alignment: {
      characters: Array.from(text),
      character_start_times_seconds: Array.from(text, (_, i) => i / 20),
      character_end_times_seconds: Array.from(text, (_, i) => (i + 1) / 20),
    },
  };
}

function fixture({ env = { GUIDE_SPEECH_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: TEST_KEY }, store = new Map() } = {}) {
  const knowledge = approvedKnowledge();
  const state = {
    store, calls: [], uploads: [], logs: [], connectorLoads: 0,
    failUpload: null, now: Date.now(),
    catalog: [{ code: "starter", name: "Starter", amount_usd: 11 }],
    catalogError: false,
    provider: async (text) => Response.json(providerResult(text)),
  };
  const urlFor = (key) => `https://storage.invalid/connectlive-brand-assets/${key}`;
  const storage = {
    getPublicUrl(key) { return { data: { publicUrl: urlFor(key) } }; },
    async upload(key, bytes, options) {
      state.uploads.push({ key, options });
      if (state.failUpload && key.endsWith(state.failUpload)) return { error: new Error("synthetic storage failure") };
      store.set(urlFor(key), { bytes, type: options.contentType });
      return { error: null };
    },
  };
  async function fetcher(input, init = {}) {
    const url = String(input);
    if (url.startsWith("https://api.elevenlabs.io/")) {
      state.calls.push({ url, init });
      return state.provider(JSON.parse(init.body).text);
    }
    const object = store.get(url.split("?")[0]);
    return object ? new Response(object.bytes, { headers: { "Content-Type": object.type } })
      : new Response("", { status: 404 });
  }
  class Clock extends Date { static now() { return state.now; } }
  const load = createGuideLoader({
    globals: {
      process: { env }, fetch: fetcher, Date: Clock,
      console: { warn: (line) => state.logs.push(line), error: (line) => state.logs.push(line) },
    },
    overrides: {
      "src/components/site/guide/guide-knowledge.ts": knowledge,
      "src/integrations/supabase/client.server.ts": {
        supabaseAdmin: { storage: { from(bucket) { assert.equal(bucket, "connectlive-brand-assets"); return storage; } } },
      },
      "src/lib/public-plan-catalog.server.ts": {
        readPublicPlanCatalog: async () => {
          if (state.catalogError) throw new Error("synthetic catalog outage");
          return state.catalog;
        },
      },
      "@tanstack/react-router": { createFileRoute: () => (options) => options },
      "@replit/connectors-sdk": {
        ReplitConnectors: class {
          constructor() { state.connectorLoads++; }
          createProxyFetch(provider) {
            assert.equal(provider, "elevenlabs");
            return (path, init) => {
              state.calls.push({ url: path, init, connector: true });
              return state.provider(JSON.parse(init.body).text);
            };
          }
        },
      },
    },
  });
  const getReply = load("src/lib/guide-answer.server.ts").getGuideReply;
  const speech = load("src/lib/guide-speech.server.ts").getGuideSpeech;
  const handler = load("src/routes/api/public/guide/speech.ts").Route.server.handlers.POST;
  const answerHandler = load("src/routes/api/public/guide/answer.ts").Route.server.handlers.POST;
  function request(body, headers = {}, route = "speech") {
    return new Request(`https://guide.invalid/api/public/guide/${route}`, {
      method: "POST", headers: { Origin: "https://guide.invalid", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  const post = (body, headers) => handler({ request: request(body, headers) });
  return { state, knowledge, load, getReply, speech, post, request, answerHandler, fetcher };
}

module.exports = { fixture, providerResult, TEST_KEY, AUDIO };
