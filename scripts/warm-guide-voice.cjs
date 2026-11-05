// Warm only server-approved replies. Verify BOTH public objects, not just the
// response URL: an audio upload alone does not prove persistent captions exist.
const fs = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function options(argv) {
  let base = "http://localhost:80";
  let suppliedBase = false;
  let only;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && !only && /^[a-z-]{1,60}$/.test(argv[i + 1] || "")) {
      only = argv[++i];
    } else if (!argv[i].startsWith("-") && !suppliedBase) {
      base = argv[i];
      suppliedBase = true;
    } else {
      throw new Error("Usage: node scripts/warm-guide-voice.cjs [base-url] [--only approved-answer-id]");
    }
  }
  try {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return { base: url, only };
  } catch {
    throw new Error("Use an HTTP(S) application URL without credentials, a query or a fragment.");
  }
}

function approvedQuestions() {
  const topics = path.join(__dirname, "../knowledge/topics");
  const entries = fs.readdirSync(topics).filter((name) => name.endsWith(".json")).sort()
    .flatMap((name) => JSON.parse(fs.readFileSync(path.join(topics, name), "utf8")).entries);
  return [
    { id: "greeting", question: "hello" },
    ...entries,
    { id: "unknown", question: "What is the weather on Mars today?" },
    // This is fixed approved outage wording, not a fabricated price.
    { id: "catalog-unavailable", question: "repeat", previousId: "catalog-unavailable" },
  ];
}

async function post(base, route, body, fetcher) {
  const response = await fetcher(new URL(`/api/public/guide/${route}`, base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base.origin },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (!response.ok) {
    const hint = response.status === 409 ? "Approved content changed; run again for the current answer."
      : response.status === 429 ? "Rate limited; wait before retrying."
      : "Check server-side provider and storage configuration; no credentials are needed in this command.";
    throw new Error(`${route}: HTTP ${response.status}. ${hint}`);
  }
  return response.json();
}

async function verifyStoredSpeech(answer, speech, fetcher = fetch) {
  if (!speech.audio?.url || speech.warning) throw new Error("Voice was not persistently cached.");
  const audioUrl = new URL(speech.audio.url);
  if (!["https:", "http:"].includes(audioUrl.protocol) || audioUrl.username || audioUrl.password
    || audioUrl.search || audioUrl.hash || !audioUrl.pathname.endsWith(".mp3")) {
    throw new Error("Voice did not return a public audio object.");
  }
  const metadataUrl = new URL(audioUrl);
  metadataUrl.pathname = metadataUrl.pathname.replace(/\.mp3$/, ".json");
  // Avoid a CDN's negative-cache entry from the pre-generation cache lookup.
  metadataUrl.searchParams.set("verify", String(Date.now()));
  const metadata = await fetcher(metadataUrl, {
    signal: AbortSignal.timeout(10000), cache: "no-store", redirect: "error",
  });
  if (!metadata.ok) throw new Error("Voice metadata could not be read from persistent storage.");
  const stored = await metadata.json();
  if (speech.text !== answer.text || stored.text !== answer.text || stored.warning
    || stored.mimeType !== "audio/mpeg" || stored.voice !== speech.voice
    || stored.audio?.url !== speech.audio.url || !Array.isArray(stored.words) || !stored.words.length
    || stored.words.map((word) => word?.text).join(" ") !== answer.text
    || JSON.stringify(stored.words) !== JSON.stringify(speech.words)
    || !Number.isFinite(stored.duration) || stored.duration <= 0 || stored.duration !== speech.duration) {
    throw new Error("Stored voice metadata does not match the current approved answer.");
  }
  const audio = await fetcher(audioUrl, {
    headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!audio.ok || !audio.headers.get("content-type")?.startsWith("audio/mpeg")) {
    await audio.body?.cancel();
    throw new Error("Voice audio could not be read from persistent storage.");
  }
  const reader = audio.body?.getReader();
  if (!reader) throw new Error("Stored voice audio is empty.");
  try {
    const first = await reader.read();
    if (first.done || !first.value?.length) throw new Error("Stored voice audio is empty.");
  } finally { await reader.cancel(); }
}

async function warmGuideVoice(argv, { fetcher = fetch, wait = sleep, log = console.info } = {}) {
  const { base, only } = options(argv);
  const questions = approvedQuestions().filter((entry) => !only || entry.id === only);
  if (!questions.length) throw new Error("That ID is not an approved guide answer.");
  let count = 0;
  for (const entry of questions) {
    if (count) await wait(4000); // Respect public limits; no privileged bypass.
    const answer = await post(base, "answer", { question: entry.question, previousId: entry.previousId }, fetcher);
    if (answer.id !== entry.id) throw new Error(`Question did not resolve to its approved entry: ${entry.id}`);
    const speech = await post(base, "speech", { answerId: answer.id, textHash: answer.textHash }, fetcher);
    await verifyStoredSpeech(answer, speech, fetcher);
    count++;
    log(`${entry.id}: persisted audio and captions verified, ${speech.words.length} words, ${speech.duration.toFixed(1)} seconds`);
  }
  log(`Verified ${count} approved voice clips in persistent storage.`);
  return count;
}

module.exports = { warmGuideVoice, verifyStoredSpeech };
if (require.main === module) {
  warmGuideVoice(process.argv.slice(2)).catch((error) => {
    // Do not print fetch exceptions: their URLs may include sensitive settings.
    console.error(error instanceof TypeError ? "Voice verification could not reach the application or storage." : error.message);
    process.exitCode = 1;
  });
}
