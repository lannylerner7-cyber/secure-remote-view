#!/usr/bin/env bun
/**
 * Smoke-check the payment surface end-to-end.
 * Usage:  BASE=https://zoomlite.live bun run scripts/verify-payment-routes.ts
 */
const BASE = process.env.BASE ?? "http://localhost:8080";

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const add = (name: string, ok: boolean, detail: string) =>
  results.push({ name, ok, detail });

async function statsOrders() {
  const r = await fetch(`${BASE}/api/public/stats/orders`);
  const body = await r.text();
  add(
    "GET /api/public/stats/orders",
    r.status === 200 && body.includes("paid"),
    `HTTP ${r.status} · ${body.slice(0, 80)}`,
  );
}

async function webhookNoSig() {
  const r = await fetch(`${BASE}/api/public/webhooks/cdp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = await r.text();
  // 401 (bad sig) or 503 (secret not configured) both prove the route is mounted & gated.
  add(
    "POST /api/public/webhooks/cdp (unsigned)",
    r.status === 401 || r.status === 503,
    `HTTP ${r.status} · ${body.slice(0, 80)}`,
  );
}

async function cronNoAuth() {
  const r = await fetch(`${BASE}/api/public/cron/reconcile-orders`, {
    method: "POST",
  });
  const body = await r.text();
  add(
    "POST /api/public/cron/reconcile-orders (no apikey)",
    r.status === 401,
    `HTTP ${r.status} · ${body.slice(0, 80)}`,
  );
}

async function orderPage() {
  const r = await fetch(`${BASE}/order`);
  add("GET /order", r.status === 200, `HTTP ${r.status}`);
}

async function licensePage() {
  const r = await fetch(`${BASE}/license`);
  add("GET /license", r.status === 200, `HTTP ${r.status}`);
}

(async () => {
  console.log(`Verifying payment routes against ${BASE}\n`);
  for (const fn of [statsOrders, webhookNoSig, cronNoAuth, orderPage, licensePage]) {
    try {
      await fn();
    } catch (e) {
      add(fn.name, false, e instanceof Error ? e.message : String(e));
    }
  }
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${pad(r.name, 55)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passing`);
  if (failed.length) process.exit(1);
})();
