const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const dir = path.join(root, "knowledge/topics");
const entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
  .flatMap((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).entries);
const source = fs.readFileSync(path.join(root, "src/components/site/guide/guide-matcher.ts"), "utf8");
const exported = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exported });
const { matchGuideEntry, normalizeGuideQuery } = exported;
const match = (input) => matchGuideEntry(input, entries)?.id ?? null;

const commands = [
  ["about", "about-what"], ["SUPPORT", "support-contact"], ["Order", "order-start"],
  ["order status", "pay-status"], ["news letter", "site-newsletter"],
  ["newsletter", "site-newsletter"], ["Pricing", "plans-list"],
  ["Agent pricing", "plans-list"], ["Agent setup", "enroll-how"],
  ["YouTube", "site-youtube"], ["experience", "site-experience"],
  ["One-time Admin", "plans-one-time-admin"], ["one-time purchase", "plans-one-time-admin"],
  ["admin", "admin-console"], ["refund", "support-refund"], ["refunds", "support-refund"],
];

for (const [command, id] of commands) {
  test(`short command ${JSON.stringify(command)} resolves to ${id}`, () => {
    assert.equal(match(command), id);
    assert.equal(match(`Please ${command}?`), id);
    assert.equal(match(`Tell me about ${command}.`), id);
  });
}

test("explicit commands are unique, regardless of topic loading order", () => {
  const seen = new Set();
  for (const entry of entries) {
    for (const alias of entry.aliases ?? []) {
      const normalized = normalizeGuideQuery(alias);
      assert.ok(!seen.has(normalized), `Duplicate alias ${alias}`);
      seen.add(normalized);
      assert.equal(matchGuideEntry(alias, [...entries].reverse())?.id, entry.id);
    }
  }
});

test("more specific intents win; generic words do not invent an answer", () => {
  assert.equal(match("What operating systems are supported?"), "start-requirements");
  assert.equal(match("How do I check my order status?"), "pay-status");
  assert.equal(match("Can I get a one-time admin purchase?"), "plans-one-time-admin");
  assert.equal(match("Can I watch the setup video?"), "site-youtube");
  assert.equal(match("What plans do you offer?"), "plans-list");
  for (const question of ["", "   ", "Will it rain tomorrow?", "My bank has a bad customer experience", "The moon is made of cheese"]) {
    assert.equal(match(question), null, question);
  }
});

test("requested static responses are brief and route to real public destinations", () => {
  const ids = new Set(commands.map(([, id]) => id));
  const paths = new Set(["/#platform", "/#security", "/#workflow", "/#setup", "/#newsletter-signup", "/plans", "/order", "/license#track", "/contact", "/connectlive/admin", "/refund"]);
  for (const entry of entries.filter((entry) => ids.has(entry.id))) {
    if (!entry.dynamic) assert.ok(entry.answer.split(/\s+/).length <= 55, entry.id);
    for (const link of entry.links ?? []) assert.ok(paths.has(link.to), `${entry.id}: ${link.to}`);
  }
  const footer = fs.readFileSync(path.join(root, "src/components/site/layout.tsx"), "utf8");
  assert.match(footer, /id="newsletter-signup"/);
});

test("guide does not promise a one-time price or read private order details", () => {
  assert.match(entries.find((entry) => entry.id === "plans-one-time-admin").answer, /contact our team.*confirm the price/i);
  assert.match(entries.find((entry) => entry.id === "pay-status").answer, /can't see private order/i);
  assert.equal(entries.find((entry) => entry.id === "plans-list").dynamic, "plans");
  assert.match(entries.find((entry) => entry.id === "support-refund").answer, /seven days.*subject to the Refund Policy/i);
});
