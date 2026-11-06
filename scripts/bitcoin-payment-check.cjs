const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuideLoader, appRequire } = require("./test-support/guide-loader.cjs");

// Published Bitcoin example addresses. Never send funds to test fixtures.
const ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const REPLACEMENT = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const ID = "637734c8-6a68-4f01-81af-af65c3a957ae";
const bitcoinDependency = appRequire("bitcoin-address-validation");

function fixture({ role = "super_admin", wallet = ADDRESS, transactions = [] } = {}) {
  const state = {
    role, calls: 0, auditFails: false, orders: [],
    wallets: wallet === undefined ? [] : [{ id: "wallet-fixture", coin: "BTC", chain: "bitcoin", cdp_wallet_id: wallet }],
    audits: [], events: [], mails: [], chainCalls: 0,
  };
  const tables = {
    plans: [{ code: "starter", name: "Starter", amount_usd: 100, active: true }],
    admin_wallets: state.wallets, orders: state.orders, audit_logs: state.audits,
    payment_events: state.events, cron_tokens: [{ name: "reconcile-orders", token: "isolated-fixture-token" }],
  };
  const db = {
    from(table) {
      state.calls++;
      const filters = [];
      let mode = "select", change, single = false;
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        in(k, values) { filters.push((r) => values.includes(r[k])); return q; },
        is(k, v) { filters.push((r) => r[k] === v); return q; },
        not(k, _, v) { filters.push((r) => r[k] !== v); return q; },
        update(value) { mode = "update"; change = value; return q; },
        insert(value) { mode = "insert"; change = value; return q; },
        upsert(value) { mode = "insert"; change = value; return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          try {
            if (table === "audit_logs" && state.auditFails) return Promise.resolve({ data: null, error: { message: "fixture audit failure" } }).then(resolve, reject);
            const source = table === "user_roles" ? [{ user_id: "fixture-user", role: state.role }] : tables[table];
            if (!source) throw new Error(`Unexpected table: ${table}`);
            let rows = source.filter((r) => filters.every((f) => f(r)));
            if (mode === "update") rows.forEach((r) => Object.assign(r, change));
            if (mode === "insert") { const row = { id: "fixture-id", ...change }; source.push(row); rows = [row]; }
            return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return q;
    },
    async rpc(name, args) {
      assert.equal(name, "create_unique_payment_order");
      state.orders.push({ id: ID, ...args._order, amount_coin: args._base_amount, status: "pending" });
      return { data: [{ order_id: ID, quoted_amount: args._base_amount }], error: null };
    },
  };
  const load = createGuideLoader({
    overrides: {
      "bitcoin-address-validation": bitcoinDependency,
      "@tanstack/react-start": {
        createServerFn() {
          let validator;
          const chain = {
            middleware() { return chain; },
            inputValidator(fn) { validator = fn; return chain; },
            handler(fn) {
              return async (options = {}) => fn({
                data: validator ? validator(options.data) : options.data,
                context: { supabase: db, userId: "fixture-user" },
              });
            },
          };
          return chain;
        },
      },
      "@/integrations/supabase/auth-middleware": { requireSupabaseAuth: {} },
      "@tanstack/react-router": { createFileRoute: () => (config) => config },
      "@/lib/cdp.server": { fetchInboundTxs: async () => {
        state.chainCalls++;
        if (transactions instanceof Error) throw transactions;
        return transactions;
      } },
      "@/integrations/supabase/client.server": { supabaseAdmin: db },
      "src/lib/order-emails.server.ts": { sendOrderEmailById: async (type) => { state.mails.push(type); return { ok: true }; } },
    },
    globals: { AbortController, fetch: async (url) => {
      assert.match(url, /BTC-USD\/spot$/);
      return Response.json({ data: { amount: "100000" } });
    } },
  });
  return { state, api: load("src/lib/orders.functions.ts"), btc: load("src/shared/bitcoin.ts"), load };
}

const orderInput = { full_name: "Payment Fixture", email: "payment-fixture@example.invalid", plan_code: "starter", coin: "BTC" };
test("Bitcoin address validation checks mainnet and checksum", () => {
  const { btc } = fixture();
  assert.equal(btc.isBitcoinAddress(ADDRESS), true);
  assert.equal(btc.isBitcoinAddress(REPLACEMENT), true);
  for (const invalid of [ADDRESS.slice(0, -1) + "b", "0x1234567890123456789012345678901234567890", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "bc1invalid", "bitcoin:" + ADDRESS, "seed phrase"]) {
    assert.equal(btc.isBitcoinAddress(invalid), false, invalid);
  }
});
test("BIP21 QR includes exact satoshis and escaped reference", () => {
  const { btc } = fixture();
  assert.equal(btc.bitcoinPaymentUri(ADDRESS, 1e-8, "CL-test & order"), `bitcoin:${ADDRESS}?amount=0.00000001&label=CL-test%20%26%20order`);
  assert.equal(btc.bitcoinPaymentUri(ADDRESS), `bitcoin:${ADDRESS}`);
  assert.equal(btc.formatBitcoinAmount("0.00100001"), "0.00100001");
  for (const amount of [0, -1, "0.000000001", "Infinity", "1e99"]) assert.throws(() => btc.bitcoinPaymentUri(ADDRESS, amount));
});
for (const coin of ["USDT_ERC20", "USDC_ERC20", "ETH", "BTC_LIGHTNING"]) {
  test(`reject new ${coin} orders before any database/rate call`, async () => {
    const { api, state } = fixture();
    await assert.rejects(api.createOrderPublic({ data: { ...orderInput, coin } }));
    assert.equal(state.calls, 0);
    assert.equal(state.orders.length, 0);
  });
}
test("new BTC invoice snapshots wallet, plan and quote via existing reservation RPC", async () => {
  const { api, state } = fixture();
  const result = await api.createOrderPublic({ data: orderInput });
  assert.equal(result.id, ID);
  assert.equal(state.orders[0].receive_address, ADDRESS);
  assert.equal(state.orders[0].coin, "BTC");
  assert.equal(state.orders[0].amount_usd, 100);
  assert.equal(Number(state.orders[0].amount_coin), 0.001);
  assert.deepEqual(state.mails, ["order_received"]);
});
test("invalid saved wallet cannot issue a new invoice", async () => {
  const { api, state } = fixture({ wallet: "bc1invalid" });
  await assert.rejects(api.createOrderPublic({ data: orderInput }), /valid Bitcoin mainnet/);
  assert.equal(state.orders.length, 0);
});
test("wallet update is saved and does not rewrite an existing invoice", async () => {
  const { api, state } = fixture();
  await api.createOrderPublic({ data: orderInput });
  await api.upsertWalletAdmin({ data: { coin: "BTC", address: REPLACEMENT, expected_address: ADDRESS } });
  assert.equal((await api.listWalletsAdmin())[0].cdp_wallet_id, REPLACEMENT);
  assert.equal((await api.getOrderPublic({ data: { id: ID } })).receive_address, ADDRESS);
  assert.equal(state.audits.length, 1);
});
test("stale wallet edits cannot overwrite a different saved address", async () => {
  const { api, state } = fixture();
  await assert.rejects(api.upsertWalletAdmin({ data: { coin: "BTC", address: REPLACEMENT, expected_address: REPLACEMENT } }), /changed the wallet/);
  assert.equal(state.wallets[0].cdp_wallet_id, ADDRESS);
});
test("invalid addresses and non-BTC settings cannot be saved", async () => {
  const { api, state } = fixture();
  await assert.rejects(api.upsertWalletAdmin({ data: { coin: "BTC", address: "bc1invalid", expected_address: ADDRESS } }));
  await assert.rejects(api.upsertWalletAdmin({ data: { coin: "USDT_ERC20", address: ADDRESS, expected_address: ADDRESS } }));
  assert.equal(state.wallets[0].cdp_wallet_id, ADDRESS);
});
for (const role of ["admin", "technician", "viewer"]) {
  test(`${role} cannot change Bitcoin wallet settings`, async () => {
    const { api, state } = fixture({ role });
    await assert.rejects(api.upsertWalletAdmin({ data: { coin: "BTC", address: REPLACEMENT, expected_address: ADDRESS } }), /Forbidden/);
    await assert.rejects(api.listWalletsAdmin(), /Forbidden/);
    assert.equal(state.wallets[0].cdp_wallet_id, ADDRESS);
  });
}
test("technicians cannot read payment-admin health, orders or totals", async () => {
  const { api } = fixture({ role: "technician" });
  for (const request of [() => api.getPaymentsHealth(), () => api.listOrdersAdmin({ data: {} }), () => api.getOrderTotals()]) {
    await assert.rejects(request(), /Forbidden/);
  }
});
test("BTC health has no Coinbase or additional coin prerequisites", async () => {
  const { api } = fixture({ role: "admin" });
  const result = await api.getPaymentsHealth();
  assert.equal(result.wallets.BTC, true);
  assert.equal(Object.keys(result.wallets).length, 1);
  assert.equal(result.confirmations_required, 2);
  assert.equal(result.cron_secret_configured, true);
  assert.match(result.monitoring_note, /must be verified/);
  assert.equal("cdp_configured" in result, false);
});
test("audit tracking failures are disclosed after a successful wallet save", async () => {
  const { api, state } = fixture();
  state.auditFails = true;
  const result = await api.upsertWalletAdmin({ data: { coin: "BTC", address: REPLACEMENT, expected_address: ADDRESS } });
  assert.match(result.warning, /Wallet saved, but audit tracking failed/);
  assert.equal(state.wallets[0].cdp_wallet_id, REPLACEMENT);
});
test("manual payment confirmation requires role, reason and an eligible state", async () => {
  const { api, state } = fixture();
  state.orders.push({ id: ID, status: "refunded" });
  await assert.rejects(api.markOrderPaid({ data: { id: ID, note: "" } }));
  await assert.rejects(api.markOrderPaid({ data: { id: ID, note: "Verified by support" } }), /cannot be marked paid/);
  state.orders[0].status = "pending";
  await api.markOrderPaid({ data: { id: ID, note: "Verified by support" } });
  assert.equal(state.orders[0].status, "paid");
  assert.equal(state.events.length, 1);
  await assert.rejects(api.markOrderPaid({ data: { id: ID, note: "Verified by support" } }), /cannot be marked paid/);
  state.role = "admin";
  await assert.rejects(api.markOrderPaid({ data: { id: ID, note: "Verified by support" } }), /Forbidden/);
});
test("legacy invoices remain readable after BTC-only cutover", async () => {
  const { api, state } = fixture();
  state.orders.push({ id: ID, coin: "USDT_ERC20", amount_coin: "100.000001", status: "paid" });
  const row = await api.getOrderPublic({ data: { id: ID } });
  assert.equal(row.coin, "USDT_ERC20");
  assert.equal(row.amount_coin, "100.000001");
});
test("blockchain outages throw rather than reporting an empty wallet", async () => {
  const load = createGuideLoader({
    overrides: { "bitcoin-address-validation": bitcoinDependency, "@/integrations/supabase/client.server": { supabaseAdmin: {} } },
    globals: { fetch: async () => new Response("Unavailable", { status: 503 }) },
  });
  await assert.rejects(load("src/lib/cdp.server.ts").fetchInboundTxs("BTC", ADDRESS), /unavailable/);
});
test("blockchain amounts and confirmations come from actual output units", async () => {
  const load = createGuideLoader({
    overrides: { "bitcoin-address-validation": bitcoinDependency, "@/integrations/supabase/client.server": { supabaseAdmin: {} } },
    globals: { fetch: async (url) => url.endsWith("/height") ? new Response("900001") : Response.json([{
      txid: "a".repeat(64), status: { confirmed: true, block_height: 900000, block_time: 1700000000 },
      vout: [{ scriptpubkey_address: ADDRESS, value: 100001 }, { scriptpubkey_address: REPLACEMENT, value: 12345 }],
    }]) },
  });
  const [tx] = await load("src/lib/cdp.server.ts").fetchInboundTxs("BTC", ADDRESS);
  assert.equal(tx.amountCoin, 0.00100001);
  assert.equal(tx.confirmations, 2);
});

const pendingInvoice = (overrides = {}) => ({
  id: ID, coin: "BTC", amount_coin: "0.00100001", receive_address: ADDRESS,
  status: "pending", tx_hash: null, confirmations: 0,
  price_locked_at: new Date(Date.now() - 120_000).toISOString(),
  price_expires_at: new Date(Date.now() + 780_000).toISOString(),
  ...overrides,
});
const reconcile = (load, authorized = true) => load("src/routes/api/public/cron/reconcile-orders.ts").Route.server.handlers.POST({
  request: new Request("https://fixture.invalid/api/public/cron/reconcile-orders", {
    method: "POST", headers: authorized ? { "x-cron-secret": "isolated-fixture-token" } : {},
  }),
});
test("reconciliation rejects unauthenticated calls without reading payments", async () => {
  const { load, state } = fixture();
  assert.equal((await reconcile(load, false)).status, 401);
  assert.equal(state.calls, 0);
});
test("a chain outage does not expire an overdue pending invoice", async () => {
  const { load, state } = fixture({ transactions: new Error("isolated outage") });
  state.orders.push(pendingInvoice({ price_expires_at: new Date(Date.now() - 120_000).toISOString() }));
  const response = await reconcile(load);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).unavailable, 1);
  assert.equal(state.orders[0].status, "pending");
});
test("a historical same-amount transaction cannot pay a newly created invoice", async () => {
  const { load, state } = fixture({ transactions: [{
    txHash: "a".repeat(64), amountCoin: 0.00100001, confirmations: 20, timestamp: Date.now() - 86400_000,
  }] });
  state.orders.push(pendingInvoice());
  assert.equal((await reconcile(load)).status, 200);
  assert.equal(state.orders[0].status, "pending");
});
test("reconciliation fetches a shared wallet once and matches only exact current quotes", async () => {
  const { load, state } = fixture({ transactions: [{
    txHash: "a".repeat(64), amountCoin: 0.00100001, confirmations: 2, timestamp: Date.now() - 30_000,
  }] });
  state.orders.push(pendingInvoice(), pendingInvoice({
    id: "ed675fa1-1512-4be6-b4c1-b68506209ad9", amount_coin: "0.00100002",
  }));
  const response = await reconcile(load);
  assert.equal(response.status, 200);
  assert.equal(state.chainCalls, 1);
  assert.equal(state.orders[0].status, "paid");
  assert.equal(state.orders[1].status, "pending");
  assert.deepEqual(state.mails, ["order_confirmed"]);
});
