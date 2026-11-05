import { createHash } from "node:crypto";
import type { GuideReply, GuideSpeech, GuideWord } from "../components/site/guide/guide-contract";
import { alignGuideWords } from "../components/site/guide/guide-captions";
import { GuideHttpError } from "./guide-http.server";
import { GUIDE_VOICE_NAME as VOICE_NAME, GUIDE_VOICE_VERSION as VOICE_VERSION, requestGuideVoice } from "./guide-speech-provider.server";

const BUCKET = "connectlive-brand-assets";
const memory = new Map<string, GuideSpeech>();
const pending = new Map<string, Promise<GuideSpeech>>();
let generationWindow = { started: Date.now(), count: 0 };
let generating = 0;

function remember(key: string, speech: GuideSpeech) {
  if (memory.size >= 64) memory.delete(memory.keys().next().value!);
  memory.set(key, speech);
}

function validStoredSpeech(value: unknown, reply: GuideReply, audioUrl: string): value is GuideSpeech {
  const item = value as GuideSpeech | null;
  if (!item || item.text !== reply.text || item.mimeType !== "audio/mpeg" || item.voice !== VOICE_NAME
    || !item.audio || typeof item.audio !== "object" || !("url" in item.audio) || item.audio.url !== audioUrl
    || item.warning !== undefined
    || !Array.isArray(item.words) || !item.words.length
    || !Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 300) return false;
  let lastStart = -1;
  for (const word of item.words) {
    if (!word || typeof word.text !== "string" || !Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.start < 0 || word.start < lastStart || word.end < word.start) return false;
    lastStart = word.start;
  }
  return item.words.map((word) => word.text).join(" ") === reply.text;
}

async function speechAssetUrls(key: string) {
  const { supabaseAdmin } = await import("../integrations/supabase/client.server");
  const base = `guide/voice/${VOICE_VERSION}/${key}`;
  const storage = supabaseAdmin.storage.from(BUCKET);
  return {
    storage, base,
    audioUrl: storage.getPublicUrl(`${base}.mp3`).data.publicUrl,
    metadataUrl: storage.getPublicUrl(`${base}.json`).data.publicUrl,
  };
}

async function generateSpeech(reply: GuideReply, key: string): Promise<GuideSpeech> {
  const assets = await speechAssetUrls(key);
  // Public, content-addressed voice assets also work on the existing Coolify
  // deployment. No Replit identity or provider credentials leave the server.
  try {
    const response = await fetch(assets.metadataUrl, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const stored: unknown = await response.json();
      if (validStoredSpeech(stored, reply, assets.audioUrl)) return stored;
    }
  } catch { /* Cache miss: generate below, with explicit provider errors. */ }

  if (Date.now() - generationWindow.started > 3_600_000) {
    generationWindow = { started: Date.now(), count: 0 };
  }
  // Cache hits are free. Bound uncached generation separately from request
  // rate limits; a caller can never send arbitrary text to this paid API.
  if (generating >= 3 || generationWindow.count >= 40) {
    throw new GuideHttpError(429, "Voice is busy right now. You can read the answer, or try listening again shortly.");
  }
  generating++;
  generationWindow.count++;
  try {
    const result = await requestGuideVoice(reply.text) as {
      audio_base64?: unknown; alignment?: Parameters<typeof alignGuideWords>[1];
    } | null;
    if (!result || typeof result.audio_base64 !== "string" || !result.audio_base64.length
      || result.audio_base64.length > 8_000_000 || !result.alignment
      || result.audio_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.audio_base64)) {
      throw new GuideHttpError(502, "The voice response was incomplete. The written answer is still available.");
    }
    const bytes = Buffer.from(result.audio_base64, "base64");
    if (bytes.length < 3 || !(bytes.subarray(0, 3).toString("ascii") === "ID3"
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
      throw new GuideHttpError(502, "The voice audio could not be verified. The written answer is still available.");
    }
    let words: GuideWord[];
    try { words = alignGuideWords(reply.text, result.alignment); }
    catch { throw new GuideHttpError(502, "Voice timing could not be verified. The written answer is still available."); }
    if (words.at(-1)!.end <= 0 || words.at(-1)!.end > 300) {
      throw new GuideHttpError(502, "Voice timing could not be verified. The written answer is still available.");
    }
    const speech: GuideSpeech = {
      audio: { base64: result.audio_base64 }, text: reply.text, words,
      mimeType: "audio/mpeg", voice: VOICE_NAME, duration: words.at(-1)!.end,
    };
    // Store bytes in the EXISTING object store, never in PostgreSQL or Git.
    // Metadata is published only after its corresponding audio upload succeeds.
    try {
      const { error } = await assets.storage.upload(`${assets.base}.mp3`, bytes, {
        contentType: "audio/mpeg", cacheControl: "31536000", upsert: true,
      });
      if (error) throw error;
      const stored: GuideSpeech = { ...speech, audio: { url: assets.audioUrl } };
      const metadata = await assets.storage.upload(`${assets.base}.json`, JSON.stringify(stored), {
        contentType: "application/json", cacheControl: "31536000", upsert: true,
      });
      if (metadata.error) throw metadata.error;
      return stored;
    } catch {
      // Playback remains real if durable caching fails; make that operational
      // failure visible without logging credentials, URLs or visitor content.
      console.warn(JSON.stringify({ scope: "homepage_guide", event: "voice_cache_write_failed" }));
      speech.warning = "Voice can play now, but couldn't be saved for later. The written answer is still available.";
    }
    return speech;
  } finally { generating--; }
}

export async function getGuideSpeech(reply: GuideReply): Promise<GuideSpeech> {
  const key = createHash("sha256").update(`${VOICE_VERSION}:${reply.textHash}`).digest("hex");
  const cached = memory.get(key);
  if (cached) return cached;
  const existing = pending.get(key);
  if (existing) return existing;
  const job = generateSpeech(reply, key).then((speech) => {
    // A partial write must not masquerade as a durable cache hit on retry.
    if ("url" in speech.audio) remember(key, speech);
    return speech;
  }).catch((error: unknown) => {
    if (error instanceof GuideHttpError) throw error;
    console.warn(JSON.stringify({ scope: "homepage_guide", event: "voice_failed" }));
    throw new GuideHttpError(503, "Voice is temporarily unavailable. You can still read every word of the answer.");
  }).finally(() => { pending.delete(key); });
  pending.set(key, job);
  return job;
}
