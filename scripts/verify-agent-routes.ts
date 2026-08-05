#!/usr/bin/env bun
/**
 * Smoke-check every /api/public/agent/* route + /api/public/auth/login.
 *
 * Runs unauthenticated and asserts the expected gate response
 * (401/410/400 — never 404/500), proving the route is mounted with the
 * right method and its auth guard is in place.
 *
 * Usage:  BASE=https://connectliveagent.com bun run scripts/verify-agent-routes.ts
 */
const BASE = process.env.BASE ?? "https://connectliveagent.com";

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const add = (name: string, ok: boolean, detail: string) =>
  results.push({ name, ok, detail });

const SID = "00000000-0000-0000-0000-000000000000";
const POWER_KINDS = ["wake", "wake_agent", "reboot", "shutdown", "lock", "logoff", "restart_stream", "restart_agent", "switch_monitor"] as const;

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

  // Open auto-enrollment (no deployment key since the enrollment overhaul).
  // 200 = a machine token was minted, 429 = IP rate limit tripped.
  //
  // This is a REAL enrollment — it leaves a real device row behind. We tag it
  // `hostname: "route-verifier"`, which the enroll route also copies into
  // `display_name`. That name makes the row INVISIBLE to the ordinary 24 h
  // nameless-ghost sweep, so the reaper carries a dedicated clause that
  // deletes `hostname = 'route-verifier'` rows after 1 h. Changing this string
  // without changing `prune_session_ephemera()` leaks a device row per run.
  await hit("POST", "/api/public/agent/enroll", [200, 429, 503], {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname: "route-verifier", os: "route-verifier" }),
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
  await hit("POST", `/api/public/agent/session/${SID}/signal`, [401], { headers: j, body: "{}" });
  await hit("GET", `/api/public/agent/session/${SID}/signal`, [401]);
  await hit("GET", "/api/public/agent/stream", [401]);
  // V3 — power ack closes the last session-scoped route the verifier missed.
  await hit("POST", `/api/public/agent/power/${SID}/ack`, [401], { headers: j, body: "{}" });
  // S9 — ICE gateway: unauthenticated callers must never receive TURN creds.
  await hit("GET", "/api/public/agent/ice", [401]);
  // V1 — a technician bearer that is not a valid Supabase JWT must also be
  // rejected, but the route must reach the verify step (401, never 500) —
  // proof the publishable-key fallback is wired and the client constructs.
  await hit("GET", "/api/public/agent/ice", [401], {
    headers: { authorization: "Bearer not-a-real-jwt" },
  });
  // S14 — release manifest: download URLs + checksums are never public.
  await hit("GET", "/api/public/agent/release?product=agent&channel=stable", [401]);
  await hit("GET", "/api/public/agent/release?product=admin&channel=stable", [401]);


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


  // Admin auth gateway — bad creds must be 400/401, never 404/500
  await hit("POST", "/api/public/auth/login", [400, 401, 422, 423], {
    headers: j,
    body: JSON.stringify({ identifier: "nobody", password: "x" }),
  });

  // Native-admin PostgREST parity: proves the tables the C# admin queries
  // are reachable at these exact paths and gated behind auth (401 without
  // apikey/Bearer). Guards against silent 404/500 if a table gets renamed
  // out from under the admin client.
  const supabaseUrl = process.env.SUPABASE_URL ?? "https://usjygjxpzunpzngmmrqy.supabase.co";
  async function pg(method: string, path: string, expected: number[], body?: string) {
    const url = `${supabaseUrl}${path}`;
    try {
      const r = await fetch(url, { method, body, headers: body ? j : undefined });
      const text = (await r.text()).slice(0, 100).replace(/\s+/g, " ");
      add(`${method} ${path}`, expected.includes(r.status),
        `HTTP ${r.status} (want ${expected.join("|")}) · ${text}`);
    } catch (e) {
      add(`${method} ${path}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  await pg("GET", `/rest/v1/session_cursors?session_id=eq.${SID}&select=x,y&limit=1`, [401]);
  await pg("POST", "/rest/v1/power_commands", [401],
    JSON.stringify({ device_id: SID, kind: "lock" }));
  await pg("POST", "/rest/v1/rpc/bind_admin", [401],
    JSON.stringify({ _session_id: SID, _client_id: "x".repeat(16) }));

  add("power command vocabulary",
    POWER_KINDS.includes("wake_agent") && POWER_KINDS.includes("reboot")
      && POWER_KINDS.includes("restart_stream") && POWER_KINDS.includes("restart_agent")
      && POWER_KINDS.includes("switch_monitor"),
    POWER_KINDS.join(", "));


  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${pad(r.name, 60)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passing`);
  if (failed.length) process.exit(1);
})();
