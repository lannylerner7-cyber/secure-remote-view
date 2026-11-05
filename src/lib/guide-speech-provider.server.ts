import { GuideHttpError } from "./guide-http.server";

// Keep these settings stable so existing content-addressed clips remain usable.
// Bump the version only when the voice, model, or voice settings change.
const VOICE_ID = "hpp4J3VqNfWAUOO0d1Us";
export const GUIDE_VOICE_NAME = "Bella · ElevenLabs";
export const GUIDE_VOICE_VERSION = "bella-multilingual-v2-s092-v1";

type SpeechProvider = "replit" | "elevenlabs" | "cache-only";
const UNAVAILABLE = "Voice is temporarily unavailable. You can still read every word of the answer.";

export function resolveGuideSpeechProvider(env: NodeJS.ProcessEnv = process.env): SpeechProvider {
  const selected = env.GUIDE_SPEECH_PROVIDER?.trim().toLowerCase() || "auto";
  if (selected === "auto") {
    if (env.REPL_ID) return "replit";
    return env.ELEVENLABS_API_KEY?.trim() ? "elevenlabs" : "cache-only";
  }
  if (selected === "replit" || selected === "elevenlabs" || selected === "cache-only") return selected;
  // Never log the supplied value: a misplaced secret must not enter logs.
  console.warn(JSON.stringify({ scope: "homepage_guide", event: "voice_provider_configuration_failed" }));
  throw new GuideHttpError(503, UNAVAILABLE);
}

/** Server-only. Call only after resolving an approved answer and its current hash. */
export async function requestGuideVoice(text: string): Promise<unknown> {
  const provider = resolveGuideSpeechProvider();
  if (provider === "cache-only"
    || (provider === "elevenlabs" && !process.env.ELEVENLABS_API_KEY?.trim())
    || (provider === "replit" && !process.env.REPL_ID)) {
    console.warn(JSON.stringify({ scope: "homepage_guide", event: "voice_provider_not_configured", provider }));
    throw new GuideHttpError(503, "This answer's voice isn't available yet. The written answer is still available.");
  }

  const path = `/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.62, similarity_boost: 0.75, style: 0.12,
        use_speaker_boost: true, speed: 0.92,
      },
      apply_text_normalization: "auto",
    }),
    signal: AbortSignal.timeout(45_000),
  };

  let response: Response;
  try {
    if (provider === "replit") {
      // The SDK and managed identity are used only inside Replit. Never export
      // its credentials or silently fall back to a different billed provider.
      const { ReplitConnectors } = await import("@replit/connectors-sdk");
      response = await new ReplitConnectors().createProxyFetch("elevenlabs")(path, init);
    } else {
      response = await fetch(`https://api.elevenlabs.io${path}`, {
        ...init,
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY!.trim(),
        },
      });
    }
  } catch {
    // Provider errors can contain headers, credentials or request text.
    console.warn(JSON.stringify({ scope: "homepage_guide", event: "voice_provider_transport_failed", provider }));
    throw new GuideHttpError(503, UNAVAILABLE);
  }
  if (!response.ok) {
    console.warn(JSON.stringify({ scope: "homepage_guide", event: "voice_provider_failed", provider, status: response.status }));
    throw new GuideHttpError(503, UNAVAILABLE);
  }
  try {
    return await response.json();
  } catch {
    throw new GuideHttpError(502, "The voice response was incomplete. The written answer is still available.");
  }
}
