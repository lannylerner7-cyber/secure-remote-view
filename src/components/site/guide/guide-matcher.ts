type MatchableEntry = {
  question: string;
  keywords: string[];
  aliases?: string[];
};

const STOPWORDS = new Set([
  "a", "an", "the", "is", "it", "to", "of", "and", "or", "in", "on", "for",
  "do", "does", "i", "we", "you", "my", "our", "me", "us", "can", "could",
  "would", "should", "what", "how", "why", "when", "where", "which", "there",
  "this", "that", "with", "about", "tell", "please", "hi", "hello", "hey",
  "work", "works", "offer", "offers", "explain",
]);

export const normalizeGuideQuery = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const stem = (word: string) =>
  word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;

/** Explicit topic commands win before stopword removal or fuzzy scoring.
 * "about" is meaningful on its own, but not in "tell me about refunds". */
export function matchGuideEntry<T extends MatchableEntry>(input: string, entries: readonly T[]): T | null {
  const normalized = normalizeGuideQuery(input);
  if (!normalized) return null;
  const command = normalized
    .replace(/^(?:(?:hi|hello|hey|please)\s+)+/, "")
    .replace(/^(?:tell me about|what about|help with|show me|explain)\s+/, "")
    .replace(/\s+(?:please|thanks)$/, "");
  const exact = entries.find((entry) =>
    normalizeGuideQuery(entry.question) === normalized
    || entry.aliases?.some((alias) => normalizeGuideQuery(alias) === command),
  );
  if (exact) return exact;

  const haystack = ` ${normalized.split(" ").map(stem).join(" ")} `;
  const tokens = new Set(normalized.split(" ").filter((word) => !STOPWORDS.has(word)).map(stem));
  let best: T | null = null;
  let bestScore = 0;
  for (const entry of entries) {
    let score = 0;
    for (const keyword of entry.keywords) {
      const needle = normalizeGuideQuery(keyword).split(" ").map(stem).join(" ");
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
  // One intentional topic word is useful. A lone weak hit in an unrelated
  // sentence is not enough to treat it as an approved product question.
  return bestScore >= 4 || (tokens.size === 1 && bestScore >= 2) ? best : null;
}
