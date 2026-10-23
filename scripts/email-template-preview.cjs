#!/usr/bin/env node
/**
 * Synthetic render test + preview generator for the shared email templates.
 * Offline only: no SMTP, no network, no DB, no secrets. Server-only deps
 * (smtp/unsub/supabase) are stubbed; TS is transpiled in-memory with the
 * project's own `typescript` package.
 *
 *   node scripts/email-template-preview.cjs
 *
 * Writes self-contained HTML (+ .txt) to generated-artifacts/email-review/.
 * Exits non-zero on any assertion failure.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "src/lib");
const OUT = path.join(ROOT, "generated-artifacts/email-review");

const STUBS = {
  "./smtp.server": { loadSmtpSettings: async () => null, sendMail: async () => { throw new Error("offline"); }, resolveSmtpSource: async () => ({ source: "none", settings: null }) },
  "./newsletter-unsub.server": { unsubUrl: async () => "https://www.connectliveagent.com/unsubscribe?t=stub" },
};

function load(file) {
  const src = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true },
    fileName: file,
  });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m.require = (id) => {
    if (STUBS[id]) return STUBS[id];
    if (id.startsWith("@/")) {
      const p = path.join(ROOT, "src", id.slice(2));
      if (p.endsWith(".json")) return JSON.parse(fs.readFileSync(p, "utf8"));
      throw new Error(`unexpected import ${id}`);
    }
    if (id.startsWith("./")) return load(path.join(path.dirname(file), id + ".ts"));
    return require(id);
  };
  m._compile(outputText, file);
  return m.exports;
}

const shell = load(path.join(LIB, "email-shell.server.ts"));
const logoBytes = fs.readFileSync(path.join(ROOT, "public/connectlive-logo-orb.png"));
if (logoBytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Email logo must be a PNG");
const previewLogo = `data:image/png;base64,${logoBytes.toString("base64")}`;
const order = load(path.join(LIB, "order-emails.server.ts"));
const news = load(path.join(LIB, "newsletter-emails.server.ts"));
const contact = load(path.join(LIB, "contact-emails.server.ts"));
const system = load(path.join(LIB, "system-emails.server.ts"));

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error("FAIL:", msg); } };
const throws = (fn, msg) => { try { fn(); check(false, msg + " (did not throw)"); } catch { /* ok */ } };

const LONG = "x".repeat(140);
const baseOrder = {
  id: "a1b2c3d4-0000-4000-8000-000000000001",
  email: "pat@example.test",
  full_name: "Pat O'Brien & <Sons>",
  plan_code: "team",
  plan_name: "Team — 25 seats",
  amount_usd: "149.5",
  coin: "USDT_TRC20",
  amount_coin: "149.5",
  receive_address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  price_expires_at: "2026-01-01T12:00:00Z",
  access_link: "https://portal.connectliveagent.com/access/abc?x=1&y=\"2\"",
};
const stressOrder = {
  ...baseOrder,
  full_name: `Bartholomew${LONG} Second`,
  plan_name: `Enterprise ${LONG}`,
  receive_address: `bc1q${"z".repeat(120)}`,
  access_link: `https://portal.connectliveagent.com/access/${"k".repeat(300)}`,
};
const contactBase = { id: "c0ffee12-3456-4789-8abc-def012345678", name: "Ana <script>alert(1)</script> Ruiz", email: "ana@example.test", phone: "+1 555 0100", message: "Hi,\nCan you do 40 seats?\n<b>not bold</b>", source: "/pricing" };
const contactStress = { ...contactBase, name: `Ana\r\nBcc: evil@x.test ${LONG}`, message: `${LONG}${LONG}\n\nhttps://example.test/${"p".repeat(200)}` };

const cases = [];
for (const kind of ["order_received", "order_confirmed", "access_ready"]) {
  cases.push([`order-${kind}`, () => order.renderOrderEmail(kind, baseOrder)]);
  cases.push([`order-${kind}-stress`, () => order.renderOrderEmail(kind, stressOrder)]);
}
cases.push(["newsletter-welcome", () => news.renderNewsletterWelcome("sub@example.test", "https://www.connectliveagent.com/unsubscribe?t=a&b=1")]);
cases.push(["newsletter-welcome-no-unsub", () => news.renderNewsletterWelcome(`very.long.${"n".repeat(80)}@example.test`)]);
cases.push(["newsletter-welcome-unsafe-unsub", () => news.renderNewsletterWelcome("sub@example.test", "javascript:alert(1)")]);
cases.push(["contact-support-notification", () => contact.renderSupportNotification(contactBase)]);
cases.push(["contact-support-notification-stress", () => contact.renderSupportNotification(contactStress)]);
cases.push(["contact-visitor-ack", () => contact.renderVisitorAck(contactBase)]);
cases.push(["contact-visitor-ack-stress", () => contact.renderVisitorAck(contactStress)]);

fs.mkdirSync(OUT, { recursive: true });
const index = [];
for (const [name, fn] of cases) {
  let r;
  try { r = fn(); } catch (e) { check(false, `${name} threw: ${e.message}`); continue; }
  const { subject, html, text } = r;
  check(html.split(`src="${shell.EMAIL_LOGO_URL}"`).length - 1 === 2, `${name}: header/footer logo missing`);
  check(html.includes('alt="ConnectLive logo"'), `${name}: logo alt text missing`);
  check(!/&amp;(amp|lt|gt|quot|#39);/.test(html), `${name}: double-escaped entity`);
  check(!/<script/i.test(html), `${name}: raw <script>`);
  check(!/href="(?!https:\/\/|mailto:)/.test(html), `${name}: non-https href`);
  check(!/[\r\n]/.test(subject), `${name}: newline in subject`);
  check(!/24.?48|within 24|inside 24/i.test(html + text), `${name}: numeric delivery promise`);
  check(/Privacy: https:\/\/www\.connectliveagent\.com\/privacy/.test(text) && /All rights reserved/.test(text), `${name}: text footer parity`);
  check(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html + text + subject), `${name}: emoji`);
  if (name.startsWith("order-")) check(/#A1B2C3D4/.test(subject), `${name}: subject lacks order ref`);
  if (name.startsWith("order-") || name.startsWith("newsletter") || name.startsWith("contact")) check(/display:none;max-height:0/.test(html), `${name}: preheader missing`);
  fs.writeFileSync(path.join(OUT, `${name}.html`), html.replaceAll(shell.EMAIL_LOGO_URL, previewLogo));
  fs.writeFileSync(path.join(OUT, `${name}.txt`), `Subject: ${subject}\n\n${text}\n`);
  index.push(`<li><a href="${name}.html">${shell.escapeHtml(name)}</a> — <a href="${name}.txt">txt</a> — ${shell.escapeHtml(subject)}</li>`);
}

for (const [name, message] of [
  ["smtp-test", system.renderSmtpTest("custom")],
  ["support-booking", system.renderSupportBooking({ email: "sample@example.test", meeting: "SAMPLE", when: "2026-10-22T10:00:00Z", timezone: "UTC", topic: "Help & setup", notes: "<script>test</script>" })],
]) {
  check(!message.html.includes("<script>"), `${name}: unsafe HTML`);
  check(message.html.split(`src="${shell.EMAIL_LOGO_URL}"`).length - 1 === 2, `${name}: header/footer logo missing`);
  check(message.html.includes('alt="ConnectLive logo"'), `${name}: logo alt text missing`);
  fs.writeFileSync(path.join(OUT, `${name}.html`), message.html.replaceAll(shell.EMAIL_LOGO_URL, previewLogo));
  fs.writeFileSync(path.join(OUT, `${name}.txt`), message.text);
  index.push(`<li><a href="${name}.html">${name}</a></li>`);
}
// Specific assertions.
const rec = order.renderOrderEmail("order_received", { ...baseOrder, full_name: "O'Brien&Co Pat" });
check(rec.html.includes("Thanks O&#39;Brien&amp;Co") && !rec.html.includes("&amp;#39;"), "order name escaped exactly once");
check(news.renderNewsletterWelcome("a@b.test", "javascript:alert(1)").html.includes("Reply with \"unsubscribe\""), "unsafe unsub falls back to reply");
check(news.renderNewsletterWelcome("a@b.test", "https://u.test/x").text.includes("Unsubscribe: https://u.test/x"), "unsub text");
throws(() => order.renderOrderEmail("access_ready", { ...baseOrder, access_link: null }), "access_ready without link");
throws(() => order.renderOrderEmail("access_ready", { ...baseOrder, access_link: "http://insecure.test/a" }), "access_ready http link");
throws(() => order.renderOrderEmail("access_ready", { ...baseOrder, access_link: "javascript:alert(1)" }), "access_ready js link");
throws(() => shell.emailButton("javascript:alert(1)", "x"), "emailButton unsafe href");

fs.writeFileSync(path.join(OUT, "index.html"), `<!doctype html><meta charset="utf-8"><title>Email review</title><h1>Email review (synthetic)</h1><ul>${index.join("")}</ul>`);
console.log(`${cases.length} templates rendered -> ${path.relative(process.cwd(), OUT)}`);
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
