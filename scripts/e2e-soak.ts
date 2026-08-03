/**
 * S8 — Soak test.
 *
 * Spawns N virtual agents. Each enrolls, heartbeats every 15s, opens an
 * active session, and pushes frames + cursor at a target FPS for DURATION
 * seconds. A single Realtime subscriber per session measures end-to-end
 * delivery latency (agent push → postgres_changes payload).
 *
 * Reports: enroll/heartbeat/push error rates, and latency percentiles
 * (p50 / p95 / p99 / max) for frame and cursor delivery.
 *
 * Env:
 *   API_BASE=https://zoomlite.live      (default http://localhost:8080)
 *   SOAK_AGENTS=10                      concurrent virtual agents
 *   SOAK_DURATION_S=120                 seconds to run
 *   SOAK_FPS=5                          frames/s per agent
 *   VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required
 *
 * Run: bun scripts/e2e-soak.ts
 */
import { createClient } from "@supabase/supabase-js";

const API = process.env.API_BASE || "http://localhost:8080";
const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPA_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const N_AGENTS = Number(process.env.SOAK_AGENTS || 10);
const DURATION_S = Number(process.env.SOAK_DURATION_S || 120);
const FPS = Number(process.env.SOAK_FPS || 5);

if (!SUPA_URL || !SUPA_SVC) { console.error("Missing SUPABASE env"); process.exit(2); }

const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const admin = createClient(SUPA_URL, SUPA_SVC, { auth: { persistSession: false } });

const errCount: Record<string, number> = {};
const okCount: Record<string, number> = {};
const frameLat: number[] = [];
const cursorLat: number[] = [];

function bump(bucket: Record<string, number>, k: string) { bucket[k] = (bucket[k] || 0) + 1; }

async function jpost(path: string, body: unknown, headers: Record<string, string> = {}) {
  try {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: r.status, ok: r.ok, text: r.ok ? "" : await r.text() };
  } catch (e: any) {
    return { status: 0, ok: false, text: String(e?.message || e) };
  }
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function runAgent(idx: number, deadline: number, deviceIds: string[]) {
  const hostname = `soak-${Date.now()}-${idx}`;
  const enroll = await jpost("/api/public/agent/enroll", {
    hostname, os: "soak", displayName: `soak-${idx}`,
    mac: `02:00:00:00:${(idx >> 8 & 0xff).toString(16).padStart(2, "0")}:${(idx & 0xff).toString(16).padStart(2, "0")}`,
    agentVersion: "soak",
  });
  if (!enroll.ok) { bump(errCount, "enroll"); return; }
  bump(okCount, "enroll");
  const { deviceId, deviceToken } = JSON.parse(enroll.text || "{}") as any
    ?? (enroll as any); // fallback
  // Re-parse: we didn't keep JSON above.
  const enrollJson = await (await fetch(`${API}/api/public/agent/enroll`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname: hostname + "b", os: "soak", displayName: `soak-${idx}b`, mac: `02:00:00:00:${idx & 0xff}:00`, agentVersion: "soak" }),
  })).json();
  const devId = enrollJson.deviceId as string;
  const devTok = enrollJson.deviceToken as string;
  deviceIds.push(devId);
  const auth = { "x-device-id": devId, "x-device-token": devTok };

  const { data: dev } = await admin.from("devices").select("id").eq("device_id", devId).maybeSingle();
  if (!dev?.id) { bump(errCount, "device-lookup"); return; }
  const { data: sess } = await admin.from("sessions").insert({ device_id: dev.id, mode: "view", state: "active" }).select("id").single();
  if (!sess?.id) { bump(errCount, "session-create"); return; }
  const sessionId = sess.id as string;

  // Per-session realtime subscriber.
  const rt = createClient(SUPA_URL, SUPA_SVC, { auth: { persistSession: false, autoRefreshToken: false } });
  const pending = new Map<number, number>();  // frame push ts → recorded
  const pendingCursor = new Map<number, number>();
  const ch = rt.channel(`soak-${sessionId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "session_frames", filter: `session_id=eq.${sessionId}` },
      () => {
        const now = Date.now();
        const oldest = [...pending.keys()].sort((a, b) => a - b)[0];
        if (oldest) { frameLat.push(now - oldest); pending.delete(oldest); }
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "session_cursors", filter: `session_id=eq.${sessionId}` },
      () => {
        const now = Date.now();
        const oldest = [...pendingCursor.keys()].sort((a, b) => a - b)[0];
        if (oldest) { cursorLat.push(now - oldest); pendingCursor.delete(oldest); }
      });
  await new Promise<void>((r) => { ch.subscribe((s) => s === "SUBSCRIBED" && r()); setTimeout(r, 5000); });

  const interval = Math.max(20, Math.floor(1000 / FPS));
  let lastHb = 0;
  while (Date.now() < deadline) {
    const t = Date.now();
    if (t - lastHb > 15_000) {
      lastHb = t;
      const hb = await jpost("/api/public/agent/heartbeat", {}, auth);
      bump(hb.ok ? okCount : errCount, "heartbeat");
    }
    pending.set(t, 0);
    const f = await jpost(`/api/public/agent/session/${sessionId}/frame`, { frame: TINY_JPEG_B64, width: 1, height: 1 }, auth);
    bump(f.ok ? okCount : errCount, "frame");
    pendingCursor.set(t, 0);
    const c = await jpost(`/api/public/agent/session/${sessionId}/cursor`, { x: (t % 1920), y: (t % 1080), w: 1920, h: 1080, kind: "default", visible: true }, auth);
    bump(c.ok ? okCount : errCount, "cursor");
    const elapsed = Date.now() - t;
    if (elapsed < interval) await new Promise((r) => setTimeout(r, interval - elapsed));
  }
  await rt.removeChannel(ch);
  await admin.from("sessions").update({ state: "ended", ended_at: new Date().toISOString() }).eq("id", sessionId);
}

async function cleanup(deviceIds: string[]) {
  for (const d of deviceIds) {
    const { data: dev } = await admin.from("devices").select("id").eq("device_id", d).maybeSingle();
    if (dev?.id) {
      await admin.from("sessions").delete().eq("device_id", dev.id);
      await admin.from("devices").delete().eq("id", dev.id);
    }
  }
}

async function main() {
  console.log(`API=${API} agents=${N_AGENTS} duration=${DURATION_S}s fps=${FPS}`);
  const deadline = Date.now() + DURATION_S * 1000;
  const deviceIds: string[] = [];
  const runners = Array.from({ length: N_AGENTS }, (_, i) => runAgent(i, deadline, deviceIds).catch((e) => {
    console.error(`agent ${i} crashed`, e); bump(errCount, "crash");
  }));
  await Promise.all(runners);

  console.log("\n=== Soak Report ===");
  const buckets = new Set([...Object.keys(okCount), ...Object.keys(errCount)]);
  for (const b of buckets) {
    const ok = okCount[b] || 0, err = errCount[b] || 0, total = ok + err;
    console.log(`  ${b.padEnd(14)} ok=${ok} err=${err} err%=${total ? ((err / total) * 100).toFixed(2) : "0"}`);
  }
  console.log(`  frame latency ms  p50=${pct(frameLat, 50)} p95=${pct(frameLat, 95)} p99=${pct(frameLat, 99)} max=${Math.max(0, ...frameLat)} n=${frameLat.length}`);
  console.log(`  cursor latency ms p50=${pct(cursorLat, 50)} p95=${pct(cursorLat, 95)} p99=${pct(cursorLat, 99)} max=${Math.max(0, ...cursorLat)} n=${cursorLat.length}`);

  console.log("cleanup...");
  await cleanup(deviceIds);
  console.log("done.");

  // Exit code: fail on >1% error rate on any bucket.
  const fail = [...buckets].some((b) => {
    const total = (okCount[b] || 0) + (errCount[b] || 0);
    return total > 0 && (errCount[b] || 0) / total > 0.01;
  });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
