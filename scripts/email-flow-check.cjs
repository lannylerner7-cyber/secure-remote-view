// Isolated regression tests: execute the actual transpiled server modules in a VM.
// No app boot, real environment, Supabase client, SMTP transport, or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ts = require("typescript");

const root = path.resolve(__dirname, "../src");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function harness() {
  const state = {
    now: 1_700_000_000_000, claims: new Map(), sends: [], logs: [],
    order: null, subscriber: { status: "subscribed" }, smtp: true,
    dbError: null, throwDb: false, smtpError: null, tokenValid: true,
    dbCalls: 0, role: null, middleware: [], updates: [],
  };
  // A tiny Supabase query surface. CAS is implemented by the DB mock, not by
  // reimplementing deliverOnce: filters and mutations come from production code.
  const db = {
    from(table) {
      state.dbCalls++;
      const query = {
        operation: "select", filters: [], patch: null,
        select() { return this; },
        eq(field, value) { this.filters.push([field, value]); return this; },
        gte() { return this; },
        order() { return this; },
        limit() { return this; },
        update(patch) { this.operation = "update"; this.patch = patch; return this; },
        insert(patch) { this.operation = "insert"; this.patch = patch; return this; },
        upsert(patch) { this.operation = "upsert"; this.patch = patch; return this; },
        maybeSingle() { return this; },
        then(resolve, reject) {
          return Promise.resolve().then(() => this.execute()).then(resolve, reject);
        },
        execute() {
          if (state.throwDb) throw new Error("synthetic_db_failure");
          if (state.dbError === this.operation || state.dbError === "all")
            return { data: null, error: { code: "synthetic_failure", message: "synthetic_db_failure" } };
          const filter = (field) => this.filters.find(([key]) => key === field)?.[1];
          if (table === "audit_logs") {
            if (this.operation === "insert") {
              if (!this.patch.id) { state.logs.push(clone(this.patch)); return { error: null }; }
              if (state.claims.has(this.patch.id)) return { error: { code: "23505" } };
              state.claims.set(this.patch.id, clone(this.patch));
              return { error: null };
            }
            const row = state.claims.get(filter("id"));
            if (this.operation === "update") {
              if (!row || row.detail.attempt !== filter("detail->>attempt"))
                return { data: [], error: null };
              if (state.dbError === "accept" && this.patch.detail.state === "accepted")
                return { error: { message: "synthetic_completion_failure" } };
              row.detail = clone(this.patch.detail);
              return { data: [{ id: row.id }], error: null };
            }
            return { data: clone(row ?? null), error: null };
          }
          if (table === "orders") return { data: clone(state.order), error: null };
          if (table === "order_emails") {
            state.logs.push(clone(this.patch));
            return { error: null };
          }
          if (table === "newsletter_subscribers") {
            if (this.operation === "update") {
              state.updates.push(clone(this.patch));
              if (state.subscriber) Object.assign(state.subscriber, this.patch);
            }
            return { data: clone(state.subscriber), count: 0, error: null };
          }
          if (table === "user_roles")
            return { data: state.role === "super_admin" ? { role: state.role } : null, error: null };
          if (table === "smtp_settings")
            return { data: { enabled: true, host: "smtp.example.invalid", from_address: "test@example.invalid", password: "synthetic-password" }, error: null };
          throw new Error(`Unexpected table: ${table}`);
        },
      };
      return query;
    },
  };
  const smtp = {
    loadSmtpSettings: async () => state.smtp ? { host: "smtp.example.invalid" } : null,
    resolveSmtpSource: async () => ({ source: "custom", settings: state.smtp ? { host: "smtp.example.invalid" } : null }),
    envSmtpSettings: () => null,
    validateSmtpSettings: () => {},
    mailErrorReason: (error) => error.message,
    sendMail: async (_settings, message) => {
      state.sends.push(clone(message));
      if (state.smtpError) throw new Error(state.smtpError);
    },
  };
  // Only the server-function builder is mocked; handlers/role checks are real.
  // Schema validation is NOT exercised here (enum coverage below is static).
  const schema = new Proxy({}, { get: (_target, name) => name === "parse" ? (x) => x : () => schema });
  const builder = () => ({
    inputValidator() { return this; },
    middleware(value) { state.middleware.push(value); return this; },
    handler(fn) { return fn; },
  });
  const cache = new Map();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      reportDiagnostics: true,
    });
    const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, `TypeScript syntax: ${relative}`);
    const customRequire = (specifier) => {
      if (specifier === "node:crypto") return crypto;
      if (specifier === "@/integrations/supabase/client.server") return { supabaseAdmin: db };
      if (specifier.endsWith("/smtp.server") || specifier === "./smtp.server") return smtp;
      if (specifier.endsWith("/newsletter-unsub.server") || specifier === "./newsletter-unsub.server")
        return {
          verifyUnsubToken: async () => state.tokenValid,
          unsubUrl: async () => "https://example.invalid/unsubscribe?synthetic-token",
        };
      if (specifier === "@tanstack/react-router") return { createFileRoute: () => (config) => config };
      if (specifier === "@tanstack/react-start") return { createServerFn: builder };
      if (specifier === "@/integrations/supabase/auth-middleware") return { requireSupabaseAuth: "synthetic-auth-middleware" };
      if (specifier === "zod") return { z: schema };
      if (specifier.endsWith(".json")) {
        const asset = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
        return JSON.parse(fs.readFileSync(asset, "utf8"));
      }
      if (specifier.startsWith(".")) return load(path.relative(root, path.resolve(path.dirname(filename), `${specifier}.ts`)));
      throw new Error(`Unmocked dependency: ${specifier}`);
    };
    vm.runInNewContext(compiled.outputText, {
      exports, require: customRequire, Date: Clock, URL, URLSearchParams, Request, Response,
      TextEncoder, crypto: crypto.webcrypto,
      console: { error() {}, log() {} }, process: { env: {} },
    }, { filename });
    return exports;
  }
  return { state, db, load };
}

test("runtime: concurrent delivery claims permit exactly one send", async () => {
  const h = harness();
  const { deliverOnce } = h.load("lib/mail-delivery.server.ts");
  let sends = 0;
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    deliverOnce("concurrent", async () => { sends++; })));
  assert.equal(sends, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(h.state.claims.size, 1);
  assert.equal([...h.state.claims.values()][0].detail.state, "accepted");
});

test("runtime: accepted duplicate is skipped; forced retry obeys exact 120s lease", async () => {
  const h = harness();
  const { deliverOnce } = h.load("lib/mail-delivery.server.ts");
  let sends = 0;
  const send = async () => { sends++; };
  assert.equal((await deliverOnce("lease", send)).ok, true);
  const duplicate = await deliverOnce("lease", send);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  h.state.now += 119_999;
  assert.equal((await deliverOnce("lease", send, true)).reason, "delivery_in_progress_or_uncertain");
  assert.equal(sends, 1);
  h.state.now += 1;
  const forced = await Promise.all([
    deliverOnce("lease", send, true), deliverOnce("lease", send, true),
  ]);
  assert.equal(forced.filter((r) => r.ok).length, 1, "forced retries must also use CAS");
  assert.equal(sends, 2);
});

test("runtime: SMTP failure stays uncertain; automatic retries remain blocked after lease", async () => {
  const h = harness();
  const { deliverOnce } = h.load("lib/mail-delivery.server.ts");
  let sends = 0;
  const send = async () => { sends++; throw new Error("synthetic_smtp_failure"); };
  assert.equal((await deliverOnce("uncertain", send)).reason, "synthetic_smtp_failure");
  assert.equal([...h.state.claims.values()][0].detail.state, "sending");
  assert.equal((await deliverOnce("uncertain", send, true)).ok, false);
  h.state.now += 120_001;
  assert.equal((await deliverOnce("uncertain", send)).reason, "delivery_in_progress_or_uncertain");
  assert.equal(sends, 1);
  assert.equal((await deliverOnce("uncertain", async () => { sends++; }, true)).ok, true);
  assert.equal(sends, 2);
});

test("runtime: database read/insert/CAS failures fail closed before SMTP", async () => {
  for (const operation of ["select", "insert", "update"]) {
    const h = harness();
    const { deliverOnce } = h.load("lib/mail-delivery.server.ts");
    if (operation === "update") {
      await deliverOnce("db", async () => {});
      h.state.now += 120_000;
    }
    h.state.dbError = operation;
    let sends = 0;
    const result = await deliverOnce("db", async () => { sends++; }, true);
    assert.equal(result.ok, false, operation);
    assert.equal(sends, 0, operation);
  }
  const h = harness();
  h.state.throwDb = true;
  let sends = 0;
  await assert.rejects(h.load("lib/mail-delivery.server.ts").deliverOnce("throw", async () => { sends++; }), /synthetic_db_failure/);
  assert.equal(sends, 0, "thrown database failure must also fail closed");
});

test("runtime: accepted SMTP with failed tracking remains claimed, not auto-resent", async () => {
  const h = harness();
  const { deliverOnce } = h.load("lib/mail-delivery.server.ts");
  h.state.dbError = "accept";
  let sends = 0;
  const send = async () => { sends++; };
  const result = await deliverOnce("tracking", send);
  assert.equal(result.ok, true);
  assert.equal(result.warning, "delivery_log_failed");
  h.state.now += 120_001;
  assert.equal((await deliverOnce("tracking", send)).ok, false);
  assert.equal(sends, 1);
});

const order = {
  id: "11111111-1111-4111-8111-111111111111", email: "test@example.invalid",
  full_name: "Test Recipient", plan_code: "test", amount_usd: 10, coin: "BTC",
  amount_coin: null, receive_address: null, price_expires_at: null,
  status: "pending", access_link: null,
};

test("runtime: order dispatcher blocks invalid state, unpaid confirmation and missing access", async () => {
  for (const [kind, patch, reason] of [
    ["order_received", { status: "paid" }, "order_no_longer_pending"],
    ["order_confirmed", { status: "pending" }, "order_not_paid"],
    ["access_ready", { status: "pending" }, "order_not_paid"],
    ["access_ready", { status: "paid" }, "access_link_missing"],
  ]) {
    const h = harness();
    h.state.order = { ...order, ...patch };
    const result = await h.load("lib/order-emails.server.ts").sendOrderEmailById(kind, order.id, true);
    assert.equal(result.reason, reason);
    assert.equal(h.state.sends.length, 0);
    assert.equal(h.state.claims.size, 0);
  }
});

test("runtime: order lookup failure and unsafe access link never send", async () => {
  const h = harness();
  const api = h.load("lib/order-emails.server.ts");
  assert.equal((await api.sendOrderEmailById("order_received", order.id)).reason, "order_not_found");
  h.state.dbError = "select";
  assert.equal((await api.sendOrderEmailById("order_received", order.id)).reason, "order_lookup_failed");
  h.state.dbError = null;
  h.state.order = { ...order, status: "paid", access_link: "javascript:alert(1)" };
  assert.match((await api.sendOrderEmailById("access_ready", order.id)).reason, /email_render/);
  assert.equal(h.state.sends.length, 0);
});

test("runtime: order accepted duplicate sends once with actual rendered access template", async () => {
  const h = harness();
  h.state.order = { ...order, status: "paid", access_link: "https://example.invalid/private-access" };
  const api = h.load("lib/order-emails.server.ts");
  assert.equal((await api.sendOrderEmailById("access_ready", order.id)).ok, true);
  assert.equal((await api.sendOrderEmailById("access_ready", order.id)).ok, true);
  assert.equal(h.state.sends.length, 1);
  assert.match(h.state.sends[0].text, /https:\/\/example.invalid\/private-access/);
  assert.equal(h.state.logs.filter((log) => log.status === "sent").length, 1);
});

test("runtime: newsletter suppressed, lookup failure, duplicate, and missing-SMTP recovery", async () => {
  const h = harness();
  const api = h.load("lib/newsletter-emails.server.ts");
  for (const subscriber of [null, { status: "unsubscribed" }]) {
    h.state.subscriber = subscriber;
    assert.equal((await api.sendNewsletterWelcome("test@example.invalid")).reason, "subscriber_suppressed");
  }
  assert.equal(h.state.sends.length, 0);
  h.state.dbError = "select";
  assert.equal((await api.sendNewsletterWelcome("test@example.invalid")).reason, "subscriber_lookup_failed");
  h.state.dbError = null;
  h.state.subscriber = { status: "subscribed" };
  h.state.smtp = false;
  assert.equal((await api.sendNewsletterWelcome("test@example.invalid")).reason, "smtp_not_configured");
  assert.equal(h.state.claims.size, 0, "missing SMTP must not poison future delivery");
  h.state.smtp = true;
  assert.equal((await api.sendNewsletterWelcome("test@example.invalid")).sent, true);
  assert.equal((await api.sendNewsletterWelcome(" TEST@example.invalid ")).sent, true);
  assert.equal(h.state.sends.length, 1);
  assert.equal(h.state.sends[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("runtime: unsubscribe GET/POST bad token is 400 without DB access", async () => {
  const h = harness();
  h.state.tokenValid = false;
  const handlers = h.load("routes/api/public/newsletter/unsubscribe.ts").Route.server.handlers;
  for (const method of ["GET", "POST"]) {
    const response = await handlers[method]({ request: new Request("https://example.invalid/?e=test%40example.invalid&t=bad", { method }) });
    assert.equal(response.status, 400);
  }
  assert.equal(h.state.dbCalls, 0);
});

test("runtime: unsubscribe GET confirms without mutation; POST DB failure is 503, not invalid link", async () => {
  const h = harness();
  h.state.dbError = "update";
  const handlers = h.load("routes/api/public/newsletter/unsubscribe.ts").Route.server.handlers;
  const url = "https://example.invalid/?e=test%40example.invalid&t=valid";
  const confirmation = await handlers.GET({ request: new Request(url) });
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /form method="post"/);
  assert.equal(h.state.dbCalls, 0, "mail scanner GET must not mutate subscriber");
  for (const thrown of [false, true]) {
    h.state.throwDb = thrown;
    const response = await handlers.POST({ request: new Request(url, { method: "POST" }) });
    assert.equal(response.status, 503, thrown ? "thrown DB error" : "returned DB error");
    assert.doesNotMatch(await response.text(), /Link not valid|^invalid$/i);
  }
});

test("runtime: unsubscribe POST form fallback updates subscriber", async () => {
  const h = harness();
  const handlers = h.load("routes/api/public/newsletter/unsubscribe.ts").Route.server.handlers;
  const response = await handlers.POST({
    request: new Request("https://example.invalid/", { method: "POST", body: "e=TEST%40example.invalid&t=valid" }),
  });
  assert.equal(response.status, 200);
  assert.equal(h.state.subscriber.status, "unsubscribed");
});

test("runtime: SMTP privileged handlers reject non-super-admin before service DB or send", async () => {
  for (const role of [null, "admin", "customer"]) {
    for (const name of ["getSmtpSettings", "saveSmtpSettings", "sendSmtpTest", "resendOrderEmail"]) {
      const h = harness();
      h.state.role = role;
      const api = h.load("lib/smtp.functions.ts");
      await assert.rejects(api[name]({
        context: { supabase: h.db, userId: "synthetic-user" }, data: {},
      }), /Forbidden/, `${name}: ${role}`);
      assert.equal(h.state.dbCalls, 1, "only the role lookup is allowed");
      assert.equal(h.state.sends.length, 0);
      assert.equal(h.state.updates.length, 0);
    }
  }
});

test("runtime: super-admin SMTP read redacts password; every handler attaches auth middleware", async () => {
  const h = harness();
  h.state.role = "super_admin";
  const api = h.load("lib/smtp.functions.ts");
  const result = await api.getSmtpSettings({ context: { supabase: h.db, userId: "synthetic-user" } });
  assert.equal(result.has_password, true);
  assert.equal(Object.hasOwn(result, "password"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-password"), false);
  assert.equal(h.state.middleware.length, Object.keys(api).length);
  for (const entry of h.state.middleware) assert.equal(entry[0], "synthetic-auth-middleware");
});

test("static only: access_ready resend enum and UI mapping include all three order kinds", () => {
  const functions = fs.readFileSync(path.join(root, "lib/smtp.functions.ts"), "utf8");
  const ui = fs.readFileSync(path.join(root, "components/EmailSettingsPanel.tsx"), "utf8");
  assert.match(functions, /z\.enum\(\["order_received", "order_confirmed", "access_ready"\]\)/);
  assert.match(ui, /\["order_received", "order_confirmed", "access_ready"\]\.includes\(kind\)/);
  assert.match(ui, /\["order_received", "order_confirmed", "access_ready"\]\.includes\(l\.kind\)/);
  assert.match(ui, /kind as "order_received" \| "order_confirmed" \| "access_ready"/);
  assert.match(ui, /Accepted by relay/);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`${tests.length - failures}/${tests.length} checks passed. Runtime VM tests use mocked boundaries; enum/UI checks are static only.`);
  if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
