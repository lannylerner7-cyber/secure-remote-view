// Opt-in, charged smoke check. Uses the real provider and existing Supabase
// bucket, but only a private-in-memory knowledge fixture and unique test paths.
// No published answer, catalog row, or existing voice object is changed.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createGuideLoader, approvedKnowledge, appRequire } = require("./test-support/guide-loader.cjs");
const { verifyStoredSpeech } = require("./warm-guide-voice.cjs");

async function main() {
  const provider = process.argv[2];
  if (!["replit", "elevenlabs"].includes(provider) || process.argv[3] !== "--confirm-charge" || process.argv.length !== 4) {
    throw new Error("usage");
  }
  // Application modules consume credentials normally. Never print or export
  // environment values. Direct mode deliberately has no Replit identity.
  const runtime = (mode) => ({
    env: new Proxy(process.env, {
      get(target, name) {
        if (name === "GUIDE_SPEECH_PROVIDER") return mode;
        if (name === "REPL_ID" && mode !== "replit") return undefined;
        return Reflect.get(target, name);
      },
    }),
  });
  const real = createGuideLoader({
    globals: { process: runtime(provider), fetch },
    overrides: { "@supabase/supabase-js": appRequire("@supabase/supabase-js") },
  });
  const { supabaseAdmin } = real("src/integrations/supabase/client.server.ts");
  const bucket = supabaseAdmin.storage.from("connectlive-brand-assets");
  const prefix = `guide/voice-verification/${randomUUID()}/`;
  const objects = new Set();
  const scopedKey = (key) => {
    assert.match(key, /^guide\/voice\/[a-z0-9-]+\/[a-f0-9]{64}\.(mp3|json)$/);
    return `${prefix}${key}`;
  };
  const storage = {
    getPublicUrl(key) { return bucket.getPublicUrl(scopedKey(key)); },
    upload(key, bytes, options) {
      const scoped = scopedKey(key);
      objects.add(scoped);
      return bucket.upload(scoped, bytes, { ...options, upsert: false });
    },
  };
  const knowledge = approvedKnowledge();
  const modules = (mode) => createGuideLoader({
    globals: { process: runtime(mode), fetch },
    overrides: {
      "src/components/site/guide/guide-knowledge.ts": knowledge,
      "src/integrations/supabase/client.server.ts": { supabaseAdmin: { storage: { from: () => storage } } },
      "@replit/connectors-sdk": provider === "replit" ? appRequire("@replit/connectors-sdk") : {
        ReplitConnectors: class { constructor() { throw new Error("Direct mode attempted managed identity"); } },
      },
    },
  });
  try {
    const load = modules(provider);
    const { getGuideReply } = load("src/lib/guide-answer.server.ts");
    const before = await getGuideReply("support-thanks");
    const entry = knowledge.knowledgeEntries.find((item) => item.id === before.id);
    // Punctuation-only fixture revision: no new product claim.
    entry.answer = entry.answer.replace("You're welcome!", "You're welcome.");
    const updated = await getGuideReply(entry.id);
    assert.notEqual(updated.textHash, before.textHash);
    const speech = await load("src/lib/guide-speech.server.ts").getGuideSpeech(updated);
    await verifyStoredSpeech(updated, speech);
    console.info(`Live ${provider}: revised approved-answer fixture generated; public audio and captions verified.`);
    const cold = modules("cache-only");
    const stored = await cold("src/lib/guide-speech.server.ts").getGuideSpeech(updated);
    assert.equal(stored.audio.url, speech.audio.url);
    assert.equal(stored.text, updated.text);
    console.info("Fresh cache-only worker read the persisted clip without provider access.");
  } finally {
    const created = [...objects];
    if (created.length) {
      assert.ok(created.every((key) => key.startsWith(prefix)));
      const { error } = await bucket.remove(created);
      if (error) throw new Error("cleanup failed");
      console.info("Removed only this check's temporary voice objects.");
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Live voice verification did not pass. Check the sanitized guide events and runtime configuration.");
    console.error("Usage: node scripts/verify-guide-voice-live.cjs replit|elevenlabs --confirm-charge");
    process.exitCode = 1;
  });
}
