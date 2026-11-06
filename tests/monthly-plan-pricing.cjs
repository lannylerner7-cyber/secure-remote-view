// Isolated catalog/checkout checks: no database, wallet or email traffic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const nested = path.join(root, ".");
const app = fs.existsSync(path.join(nested, "src")) ? nested : root;
const appRequire = createRequire(path.join(app, "package.json"));
const ts = appRequire("typescript");

function load(file, dependencies = {}) {
  const output = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module: output, exports: output.exports, console, Date, Promise,
    setTimeout, clearTimeout,
    fetch: () => { throw new Error("Network calls are forbidden in this test"); },
    require: (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
  }, { filename: file });
  return output.exports;
}

const expected = [
  { code: "starter", amount_usd: 19, devices: "10 devices" },
  { code: "team", amount_usd: 35, devices: "20 devices" },
  { code: "business", amount_usd: 86, devices: "50 devices" },
];
const siteRoots = [path.join(app, "src/components/site")];
const previewSite = path.join(root, "artifacts/connectlive-preview/src/components/site");
if (fs.existsSync(previewSite)) siteRoots.push(previewSite);
for (const site of siteRoots) {
  const { plans } = load(path.join(site, "data.ts"));
  const paid = JSON.parse(JSON.stringify(plans.filter((p) => p.slug !== "custom")));
  assert.deepEqual(paid.map((p) => ({
    code: p.slug, devices: p.devices,
  })), expected.map(({ code, devices }) => ({ code, devices })));
  assert.ok(plans.every((p) => !Object.hasOwn(p, "monthly")),
    "Marketing metadata must not maintain its own prices");
  assert.equal(plans.find((p) => p.slug === "custom").contactPricing, true);
  for (const file of fs.readdirSync(site).filter((name) => /\.tsx?$/.test(name))) {
    assert.doesNotMatch(fs.readFileSync(path.join(site, file), "utf8"),
      /WAS_PRICE|46%|Promo applied|Promo pricing|\$(?:150|310|560|250|570|840)\b/,
      `Stale advertised pricing in ${file}`);
  }
}

const migration = fs.readFileSync(path.join(app,
  "supabase/migrations/20261104000000_monthly_plan_prices.sql"), "utf8");
for (const plan of expected)
  assert.ok(migration.includes(`('${plan.code}', ${plan.amount_usd}.00)`));
assert.doesNotMatch(migration,
  /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE)\s+(?:public\.)?(?:orders|licenses)\b/i);
assert.doesNotMatch(fs.readFileSync(path.join(app, "src/routes/plans.tsx"), "utf8"),
  /Promo pricing|46%/);

const rows = expected.map((p, index) => ({
  code: p.code, name: p.code, description: p.devices,
  amount_usd: p.amount_usd, active: true, sort_order: (index + 1) * 10,
}));
const quotes = [];
let planQueries = 0;
const supabaseAdmin = {
  from(table) {
    assert.equal(table, "plans", "Tests must not touch orders or licenses");
    let code;
    return {
      select() { return this; },
      eq(column, value) {
        if (column === "code") code = value;
        else { assert.equal(column, "active"); assert.equal(value, true); }
        return this;
      },
      async maybeSingle() {
        planQueries++;
        return { data: rows.find((p) => p.code === code) ?? null, error: null };
      },
      async order() { return { data: rows, error: null }; },
    };
  },
  async rpc(name, input) {
    assert.equal(name, "create_unique_payment_order");
    quotes.push(input);
    return { data: [{ order_id: "synthetic-pricing-order" }], error: null };
  },
};

function createServerFn() {
  let validate = (raw) => raw;
  return {
    inputValidator(fn) { validate = fn; return this; },
    middleware() { return this; },
    handler(fn) {
      return (input = {}) => fn({ data: validate(input.data), context: {} });
    },
  };
}
const rates = { BTC: 100000 };
const conversions = load(path.join(app, "src/lib/pricing.server.ts"));
const paymentIdentity = load(path.join(app, "src/shared/payment-identity.ts"));
const bitcoin = load(path.join(app, "src/shared/bitcoin.ts"), {
  "bitcoin-address-validation": appRequire("bitcoin-address-validation"),
  "./payment-identity": paymentIdentity,
});
const catalog = load(path.join(app, "src/lib/public-plan-catalog.server.ts"), {
  "@/integrations/supabase/client.server": { supabaseAdmin },
});
const orders = load(path.join(app, "src/lib/orders.functions.ts"), {
  "@tanstack/react-start": { createServerFn },
  "@/integrations/supabase/auth-middleware": { requireSupabaseAuth: {} },
  zod: appRequire("zod"),
  "@/shared/bitcoin": bitcoin,
  "./pricing.server": { ...conversions, getUsdToCoinRates: async () => rates },
  "@/integrations/supabase/client.server": { supabaseAdmin },
  "./cdp.server": { issueReceiveAddress: async () => "synthetic-receiving-address" },
  "./order-emails.server": { sendOrderEmailById: async () => {} },
  "./public-plan-catalog.server": catalog,
});

(async () => {
  assert.deepEqual((await orders.getActivePlansPublic()).map((p) => p.amount_usd), [19, 35, 86]);
  for (const plan of expected) {
    for (const coin of Object.keys(rates)) {
      await orders.createOrderPublic({ data: {
        full_name: "Pricing test", email: "pricing@example.invalid",
        plan_code: plan.code, coin, amount_usd: 1,
      } });
      const quote = quotes.at(-1);
      assert.equal(quote._order.plan_code, plan.code);
      assert.equal(quote._order.amount_usd, plan.amount_usd,
        "Invoice must use the catalog price, not a client-supplied amount");
      assert.equal(Number(quote._base_amount),
        conversions.usdToCoin(plan.amount_usd, coin, rates));
      assert.equal(new Date(quote._order.price_expires_at) -
        new Date(quote._order.price_locked_at), 15 * 60 * 1000);
    }
  }
  assert.equal(planQueries, 3, "Each new BTC quote reads the current database price");
  await assert.rejects(orders.createOrderPublic({ data: {
    full_name: "Pricing test", email: "pricing@example.invalid",
    plan_code: "custom", coin: "BTC",
  } }), /Plan not available/);
  assert.equal(quotes.length, 3, "Custom enterprise must not issue a fixed-price invoice");
  rows[0].amount_usd = 23.75;
  assert.equal((await catalog.readPublicPlanCatalog())[0].amount_usd, 23.75,
    "Marketing catalog must read future database prices, not a fixed amount");
  assert.equal((await orders.getActivePlansPublic())[0].amount_usd, 23.75);
  await orders.createOrderPublic({ data: {
    full_name: "Pricing test", email: "pricing@example.invalid",
    plan_code: "starter", coin: "BTC", amount_usd: 19,
  } });
  assert.equal(quotes.at(-1)._order.amount_usd, 23.75);
  assert.equal(quotes[0]._order.amount_usd, 19, "Already-issued quotes retain their locked amounts");
  rows[0].amount_usd = NaN;
  await assert.rejects(catalog.readPublicPlanCatalog(), /invalid price/);
  console.log("PASS: live catalog parity, future price changes, 10/20/50 limits, four isolated BTC quotes, locked existing amounts, invalid-price rejection and no marketing price literals.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
