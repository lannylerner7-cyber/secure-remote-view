import manifestJson from "../../../../knowledge/manifest.json";
import { plans as displayPlans } from "../data";
import { matchGuideEntry } from "./guide-matcher";

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
  aliases?: string[];
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

/** Match only approved knowledge; never turn a public prompt into a live
 * account lookup, checkout action, or arbitrary generated answer. */
export function findAnswer(input: string): KnowledgeEntry | null {
  return matchGuideEntry(input, knowledgeEntries);
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
    text: `Current monthly plans:\n${parts.join("\n")}\nEnterprise has custom pricing. See Plans to compare what's included.`,
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
