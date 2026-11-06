import { createHash } from "node:crypto";
import {
  findAnswer, guideManifest, knowledgeEntries,
  type ResolvedAnswer,
} from "../components/site/guide/guide-knowledge";
import type { GuideReply } from "../components/site/guide/guide-contract";
import { plans as displayPlans } from "../components/site/data";

const UNAVAILABLE = "I can't confirm current prices because the live catalog isn't reachable right now. Please check the Plans page, or try again in a moment.";

function reply(id: string, answer: ResolvedAnswer, source: GuideReply["source"] = "knowledge"): GuideReply {
  // The identical approved string goes to chat, captions, and the voice service.
  const text = answer.text.replace(/\s+/g, " ").trim();
  return {
    ...answer, id, text, source,
    textHash: createHash("sha256").update(text).digest("hex"),
  };
}

export async function getGuideReply(id: string): Promise<GuideReply | null> {
  if (id === "greeting") return reply(id, {
    text: guideManifest.greeting, emotion: "friendly", animation: "wave",
  });
  if (id === "unknown") return reply(id, {
    text: guideManifest.unknownAnswer, emotion: "uncertain", animation: "talk_raised",
    links: [{ label: "Contact the team", to: "/contact" }],
  }, "unverified");
  if (id === "catalog-unavailable") return reply(id, {
    text: UNAVAILABLE, emotion: "concerned", animation: "talk_raised",
    links: [{ label: "Check current plans", to: "/plans" }],
  }, "unverified");
  const entry = knowledgeEntries.find((item) => item.id === id);
  if (!entry) return null;
  const answer: ResolvedAnswer = {
    text: entry.answer, emotion: entry.emotion, animation: entry.animation,
    board: entry.board, links: entry.links,
  };
  if (entry.dynamic === "plans") {
    try {
      const { readPublicPlanCatalog } = await import("./public-plan-catalog.server");
      const rows = await readPublicPlanCatalog();
      if (!rows.length) throw new Error("Empty catalog");
      answer.text = rows.map((row) => {
        const plan = displayPlans.find((item) => item.slug === row.code);
        return `${row.name} is ${Number(row.amount_usd)} US dollars per month${plan ? `, for ${plan.devices.toLowerCase()}` : ""}.`;
      }).join(" ") + " Enterprise has custom pricing. See Plans to compare what's included.";
      return reply(id, answer, "catalog");
    } catch {
      return getGuideReply("catalog-unavailable");
    }
  }
  return reply(id, answer);
}

export async function answerGuideQuestion(question: string, previousId?: string): Promise<GuideReply> {
  const normalized = question.toLowerCase().replace(/[!?.,]/g, "").trim();
  let id: string;
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)$/.test(normalized)) {
    id = "greeting";
  } else if (/^(thank you|thanks|thank you very much|thanks a lot)$/.test(normalized)) {
    id = "support-thanks";
  } else if (/^(repeat|say that again|repeat that|explain that again)$/.test(normalized) && previousId) {
    id = previousId;
  } else {
    id = findAnswer(question)?.id ?? "unknown";
  }
  return (await getGuideReply(id)) ?? (await getGuideReply("unknown"))!;
}
