import manifestJson from "../../../../knowledge/manifest.json";
import { plans as displayPlans } from "../data";

export type GuideEmotion =
  | "neutral"
  | "friendly"
  | "attentive"
  | "thoughtful"
  | "uncertain"
  | "concerned";

/** Logical animation ids used in knowledge files. guide-scene maps them to
 * clips that actually exist in the rigged model. */
export type GuideAnimationId = "sit_idle" | "wave" | "talk_open" | "talk_raised";

export type KnowledgeLink = { label: string; to: string };
export type KnowledgeBoard = { heading: string; lines: string[] };

export type KnowledgeEntry = {
  id: string;
  keywords: string[];
  question: string;
  answer: string;
  board?: KnowledgeBoard;
  emotion: GuideEmotion;
  animation: GuideAnimationId;
  links?: KnowledgeLink[];
  dynamic?: "plans";
};

export type GuideManifest = {
  version: number;
  updatedAt: string;
  assistantName: string;
  greeting: string;
  unknownAnswer: string;
  emotions: GuideEmotion[];
  animations: GuideAnimationId[];
  topics: string[];
};

type TopicFile = { id: string; title: string; entries: KnowledgeEntry[] };

export const guideManifest = manifestJson as GuideManifest;

const topicModules = import.meta.glob("../../../../knowledge/topics/*.json", { eager: true });

function asTopic(mod: unknown): TopicFile {
  const candidate = (mod as { default?: unknown })?.default ?? mod;
  return candidate as TopicFile;
}

export const knowledgeEntries: KnowledgeEntry[] = Object.values(topicModules).flatMap(
  (mod) => asTopic(mod).entries ?? [],
);

const STOPWORDS = new Set([
  "a", "an", "the", "is", "it", "to", "of", "and", "or", "in", "on", "for",
  "do", "does", "i", "we", "you", "my", "our", "me", "us", "can", "could",
  "would", "should", "what", "how", "why", "when", "where", "which", "there",
  "this", "that", "with", "about", "tell", "please", "hi", "hello", "hey",
  "work", "works", "offer", "offers", "explain",
]);

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word && !STOPWORDS.has(word))
      .map(stem),
  );
}

/**
 * Local, deterministic matcher over the knowledge folder. A phrase keyword
 * hit scores higher than single words; two single-word hits or one phrase is
 * required before an entry is considered verified enough to answer with.
 */
export function findAnswer(input: string): KnowledgeEntry | null {
  const haystack = ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  const normalized = haystack.trim();
  const exact = knowledgeEntries.find((entry) =>
    entry.question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() === normalized,
  );
  if (exact) return exact;
  const tokens = words(input);
  let best: KnowledgeEntry | null = null;
  let bestScore = 0;
  for (const entry of knowledgeEntries) {
    let score = 0;
    for (const keyword of entry.keywords) {
      const needle = keyword.toLowerCase();
      if (needle.includes(" ")) {
        if (haystack.includes(` ${needle} `)) score += 4 + needle.split(" ").length;
      } else if (tokens.has(stem(needle))) {
        score += 2;
      }
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  // A short, exact topic keyword is useful ("pricing", "enrollment"). Do not
  // answer an unrelated sentence just because it happens to contain one word.
  return bestScore >= 4 || (tokens.size === 1 && bestScore >= 2) ? best : null;
}

export type ResolvedAnswer = {
  text: string;
  emotion: GuideEmotion;
  animation: GuideAnimationId;
  board?: KnowledgeBoard;
  links?: KnowledgeLink[];
};

type CatalogPlanRow = { code: string; name: string; amount_usd: number };

/** Prices always come from the live catalog (same reader as checkout). */
async function resolvePlansAnswer(entry: KnowledgeEntry): Promise<ResolvedAnswer> {
  const base = { emotion: entry.emotion, animation: entry.animation, board: entry.board, links: entry.links };
  let rows: CatalogPlanRow[] = [];
  try {
    const res = await fetch("/api/public/plans", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = (await res.json()) as { plans?: unknown };
    if (!res.ok || !Array.isArray(body?.plans)) throw new Error("catalog unavailable");
    rows = (body.plans as CatalogPlanRow[]).filter(
      (row) => row && typeof row.name === "string" && Number(row.amount_usd) > 0,
    );
  } catch {
    rows = [];
  }
  if (!rows.length) {
    return {
      ...base,
      text: "Current prices can't be confirmed from here right now — the live catalog isn't reachable. The Plans page always shows the verified amounts, or I can try again in a moment.",
    };
  }
  const parts = rows.map((row) => {
    const display = displayPlans.find((plan) => plan.slug === row.code);
    const devices = display ? `, ${display.devices.toLowerCase()}` : "";
    return `${row.name} — $${Number(row.amount_usd)}/mo${devices}`;
  });
  return {
    ...base,
    text: `Current monthly plans, straight from the live catalog:\n${parts.join("\n")}\nEnterprise is unlimited and priced by conversation. Payments are crypto only (BTC, USDT or USDC ERC-20), and a price change never rewrites an invoice that was already issued.`,
  };
}

export async function resolveEntry(entry: KnowledgeEntry): Promise<ResolvedAnswer> {
  if (entry.dynamic === "plans") return resolvePlansAnswer(entry);
  return {
    text: entry.answer,
    emotion: entry.emotion,
    animation: entry.animation,
    board: entry.board,
    links: entry.links,
  };
}
