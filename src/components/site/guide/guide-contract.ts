import type { GuideAnimationId, GuideEmotion, KnowledgeBoard, KnowledgeLink } from "./guide-knowledge";

/** All spoken copy is resolved from approved knowledge on the server. */
export type GuideReply = {
  id: string;
  text: string;
  textHash: string;
  source: "knowledge" | "catalog" | "unverified";
  emotion: GuideEmotion;
  animation: GuideAnimationId;
  board?: KnowledgeBoard;
  links?: KnowledgeLink[];
};

/** Provider alignment, in seconds of the actual audio — not a reading timer. */
export type GuideWord = { text: string; start: number; end: number };

export type GuideSpeech = {
  audio: { url: string } | { base64: string };
  mimeType: "audio/mpeg";
  words: GuideWord[];
  text: string;
  duration: number;
  voice: string;
  /** Playback is usable, but durable storage failed. Never saved in metadata. */
  warning?: string;
};

export type GuideActivity = "seated" | "greeting" | "speaking" | "presenting" | "paused";

/** One complete, bounded caption page, rendered on the physical board. */
export type GuideBoardPage = {
  heading: string;
  words: string[];
  activeWord: number;
  page: number;
  pages: number;
  status: string;
};

export const GUIDE_EVENTS = [
  "section_viewed", "scene_ready", "scene_failed", "static_mode", "question_sent",
  "answer_ready", "answer_failed", "voice_enabled", "voice_disabled",
  "voice_loading", "voice_started", "voice_paused", "voice_completed",
  "voice_failed", "voice_replayed", "caption_page", "movement",
  "guide_hidden", "guide_shown",
] as const;
export type GuideEventName = (typeof GUIDE_EVENTS)[number];
export type GuideEventData = {
  topic?: string;
  page?: number;
  durationMs?: number;
  phase?: string;
  reason?: string;
};
