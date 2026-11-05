import type { GuideWord } from "./guide-contract";

export type CaptionPage = { start: number; end: number; words: string[] };

/** Character budget, not just word count: every word survives pagination. */
export function paginateGuideWords(words: string[]): CaptionPage[] {
  if (!words.length) return [{ start: 0, end: 0, words: [] }];
  const pages: CaptionPage[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let characters = 0;
    while (end < words.length && end - start < 22) {
      const next = words[end].length + (end > start ? 1 : 0);
      if (end > start && characters + next > 142) break;
      characters += next;
      end++;
    }
    // Prefer a natural sentence boundary, without creating tiny pages.
    if (end < words.length) {
      for (let boundary = end; boundary > start + 9; boundary--) {
        if (/[.!?]$/.test(words[boundary - 1])) { end = boundary; break; }
      }
    }
    pages.push({ start, end, words: words.slice(start, end) });
    start = end;
  }
  return pages;
}

export function activeGuideWord(words: GuideWord[], seconds: number): number {
  let low = 0;
  let high = words.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (words[mid].start <= seconds) { index = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return index;
}

type CharacterAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/** Use ORIGINAL alignment so captions cannot diverge from the approved reply. */
export function alignGuideWords(text: string, alignment: CharacterAlignment): GuideWord[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)
    || characters.length !== starts.length || characters.length !== ends.length
    || characters.join("") !== text) throw new Error("Speech alignment does not match approved text");
  const words: GuideWord[] = [];
  let word = "";
  let start = 0;
  let end = 0;
  let previousStart = -1;
  for (let index = 0; index < characters.length; index++) {
    if (!Number.isFinite(starts[index]) || !Number.isFinite(ends[index])
      || starts[index] < 0 || starts[index] < previousStart || ends[index] < starts[index]) {
      throw new Error("Invalid speech alignment");
    }
    previousStart = starts[index];
    const character = characters[index];
    if (/\s/.test(character)) {
      if (word) words.push({ text: word, start, end });
      word = "";
    } else {
      if (!word) start = starts[index];
      word += character;
      end = ends[index];
    }
  }
  if (word) words.push({ text: word, start, end });
  if (!words.length || words.map((item) => item.text).join(" ") !== text) {
    throw new Error("Incomplete speech alignment");
  }
  return words;
}
