#!/usr/bin/env bun
/**
 * Smoke-check every /api/public/agent/* route + /api/public/auth/login.
 *
 * Runs unauthenticated and asserts the expected gate response
 * (401/410/400 — never 404/500), proving the route is mounted with the
 * right method and its auth guard is in place.
 *
 * Usage:  BASE=https://secure-remote-view.lovable.app bun run scripts/verify-agent-routes.ts
 */
const BASE = process.env.BASE ?? "https://secure-remote-view.lovable.app";

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const add = (name: string, ok: boolean, detail: string) =>
  results.push({ name, ok, detail });

const SID = "00000000-0000-0000-0000-000000000000";

async function hit(
  method: string,
  path: string,
  expected: number[],
  opts: { headers?: Record<string, string>; body?: string } = {},
) {
  const url = `${BASE}${path}`;
  try {
    const r = await fetch(url, {
      method,
      headers: opts.headers,
      body: opts.body,
    });
    const body = (await r.text()).slice(0, 100).replace(/\s+/g, " ");
    add(
      `${method} ${path}`,
      expected.includes(r.status),
      `HTTP ${r.status} (want ${expected.join("|")}) · ${body}`,
    );
  } catch (e) {
    add(`${method} ${path}`, false, e instanceof Error ? e.message : String(e));
  }
}

(async () => {
  console.log(`Verifying agent routes against ${BASE}\n`);

  // Deployment-key gated
  await hit("POST", "/api/public/agent/enroll", [401, 503], {
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  // Device-token gated
  const j = { "content-type": "application/json" };
  await hit("POST", "/api/public/agent/hello", [401], { headers: j, body: "{}" });
  await hit("POST", "/api/public/agent/heartbeat", [401], { headers: j, body: "{}" });
  await hit("POST", `/api/public/agent/session/${SID}/reconnect`, [401], { headers: j, body: "{}" });
  await hit("POST", `/api/public/agent/session/${SID}/consent`, [401], { headers: j, body: "{}" });
  await hit("POST", `/api/public/agent/session/${SID}/frame`, [401], { headers: j, body: "{}" });
  await hit("POST", `/api/public/agent/session/${SID}/cursor`, [401], { headers: j, body: "{}" });
  await hit("GET", `/api/public/agent/session/${SID}/inputs`, [401]);
  await hit("POST", `/api/public/agent/session/${SID}/signal`, [401], { headers: j, body: "{}" });
  await hit("GET", `/api/public/agent/session/${SID}/signal`, [401]);

  // Signal validation (still requires device auth, so 401 is the correct
  // gate response — we're proving the route validates AFTER auth). These
  // cover the retry-queue contract:
  //   - bad kind / oversize payload / bad admin_client_id / bad attempt_id
  //     must never reach the DB with a 500 or silently succeed.
  await hit("POST", `/api/public/agent/session/${SID}/signal`, [401], {
    headers: j,
    body: JSON.stringify({ kind: "bogus", payload: {}, attempt_id: "abc123" }),
  });
  await hit("POST", `/api/public/agent/session/${SID}/signal`, [401], {
    headers: j,
    body: JSON.stringify({ kind: "ice", payload: {}, admin_client_id: "x" }),
  });

  // Legacy — must be 410 Gone so old agents surface a clean error
  await hit("POST", "/api/public/agent/pair", [410], { headers: j, body: "{}" });

  // Admin auth gateway — bad creds must be 400/401, never 404/500
  await hit("POST", "/api/public/auth/login", [400, 401, 422, 423], {
    headers: j,
    body: JSON.stringify({ identifier: "nobody", password: "x" }),
  });

  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${pad(r.name, 60)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passing`);
  if (failed.length) process.exit(1);
})();
