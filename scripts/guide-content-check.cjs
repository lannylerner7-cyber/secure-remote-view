const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/components/site/guide/guide-captions.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exportsObject = {};
vm.runInNewContext(js, { exports: exportsObject });
const { paginateGuideWords, activeGuideWord, alignGuideWords } = exportsObject;

test("every approved word survives pagination, in order, once", () => {
  const input = Array.from({ length: 253 }, (_, i) => `word${i}${i % 9 === 8 ? "." : ""}`);
  const pages = paginateGuideWords(input);
  assert.deepEqual(Array.from(pages.flatMap((page) => page.words)), input);
  pages.forEach((page, i) => {
    assert.equal(page.start, i ? pages[i - 1].end : 0);
    assert.ok(page.end > page.start);
    assert.ok(page.words.length <= 22);
    assert.ok(page.words.join(" ").length <= 142);
  });
});

test("a long unbroken token is retained, not discarded or looped forever", () => {
  const input = ["First", "a".repeat(220), "last."];
  const pages = paginateGuideWords(input);
  assert.deepEqual(Array.from(pages.flatMap((page) => page.words)), input);
  assert.equal(pages.at(-1).end, 3);
});

test("empty captions have a safe empty page", () => {
  const pages = paginateGuideWords([]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].words.length, 0);
});

test("captions follow real audio timestamps, including silence and seeks", () => {
  const words = [{ text: "Hello.", start: 0.2, end: 0.8 }, { text: "Welcome", start: 1.8, end: 2.3 }, { text: "back.", start: 2.5, end: 3 }];
  assert.equal(activeGuideWord(words, 0), -1);
  assert.equal(activeGuideWord(words, 0.3), 0);
  assert.equal(activeGuideWord(words, 1.5), 0);
  assert.equal(activeGuideWord(words, 1.8), 1);
  assert.equal(activeGuideWord(words, 99), 2);
  assert.equal(activeGuideWord(words, 0.25), 0);
  assert.equal(activeGuideWord([], 2), -1);
});

function alignment(text) {
  return {
    characters: Array.from(text),
    character_start_times_seconds: Array.from(text, (_, i) => i / 10),
    character_end_times_seconds: Array.from(text, (_, i) => (i + 1) / 10),
  };
}

test("original provider alignment preserves punctuation and every spoken token", () => {
  const text = "Hello, I'm your guide — welcome.";
  const words = alignGuideWords(text, alignment(text));
  assert.equal(words.map((word) => word.text).join(" "), text);
  assert.equal(words[0].start, 0);
  assert.equal(words.at(-1).end, text.length / 10);
});

test("mismatched provider text cannot silently create inaccurate captions", () => {
  assert.throws(() => alignGuideWords("Real answer.", alignment("Other text.")));
});

test("missing, non-finite and backwards timestamps are rejected", () => {
  const text = "Hello.";
  const short = alignment(text);
  short.character_end_times_seconds.pop();
  assert.throws(() => alignGuideWords(text, short));
  const bad = alignment(text);
  bad.character_start_times_seconds[2] = NaN;
  assert.throws(() => alignGuideWords(text, bad));
  const backwards = alignment(text);
  backwards.character_start_times_seconds[2] = -1;
  assert.throws(() => alignGuideWords(text, backwards));
});
