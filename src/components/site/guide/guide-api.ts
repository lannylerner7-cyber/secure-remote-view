import type { GuideReply, GuideSpeech } from "./guide-contract";

async function post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/public/guide/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin", signal, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The guide couldn't respond. Please try again.");
  return result as T;
}

export function askGuide(question: string, previousId: string | undefined, signal: AbortSignal) {
  return post<GuideReply>("answer", { question, previousId }, signal);
}

export function loadGuideSpeech(reply: GuideReply, signal: AbortSignal) {
  return post<GuideSpeech>("speech", { answerId: reply.id, textHash: reply.textHash }, signal);
}
