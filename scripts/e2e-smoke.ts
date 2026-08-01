/**
 * End-to-end smoke test:
 *   1. Enroll a virtual agent.
 *   2. Heartbeat once.
 *   3. Create a session (via service-role bypass — no admin UI needed).
 *   4. Push a synthetic JPEG frame + cursor.
 *   5. Assert Supabase Realtime delivers frame+cursor to a live subscriber
 *      using the SAME filters as the admin console.
 *   6. Assert REST fallback returns matching rows.
 *   7. Tear down.
 *
 *   Run:  API_BASE=https://zoomlite.live bun scripts/e2e-smoke.ts
 *   (defaults to localhost:8080)
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const API = process.env.API_BASE || "http://localhost:8080";
const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPA_PUB = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY!;
const SUPA_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPA_URL || !SUPA_PUB || !SUPA_SVC) {
  console.error("Missing SUPABASE env"); process.exit(2);
}

// 1×1 red JPEG.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const timeoutSignal = (ms: number) => AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;

async function jpost(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: timeoutSignal(20_000),
  });
  const text = await r.text();
  let data: any = null; try { data = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, data, text };
}

function log(step: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${step}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const admin = createClient(SUPA_URL, SUPA_SVC, { auth: { persistSession: false } });

async function main() {
  console.log(`API = ${API}`);
  // --- 1. Enroll ---
  const enroll = await jpost("/api/public/agent/enroll", {
    hostname: `smoke-${Date.now()}`,
    os: "smoke-test",
    displayName: "e2e-smoke",
    mac: "00:00:00:00:00:00",
    agentVersion: "e2e",
  });
  log("enroll", enroll.status === 200 && !!enroll.data?.deviceId, enroll.data ?? enroll.text);
  if (enroll.status !== 200) return cleanup();
  const { deviceId, deviceToken } = enroll.data as { deviceId: string; deviceToken: string };
  const authHeaders = { "x-device-id": deviceId, "x-device-token": deviceToken };

  // --- 2. Heartbeat ---
  const hb = await jpost("/api/public/agent/heartbeat", { lan: { subnet_v4: "10.99.0.0/24", mac: "00:00:00:00:00:00" } }, authHeaders);
  log("heartbeat", hb.status === 200, hb.data);

  // Lookup db row id.
  const { data: dev } = await admin.from("devices").select("id, metadata").eq("device_id", deviceId).maybeSingle();
  log("device row", !!dev?.id, dev?.id);
  if (!dev?.id) return cleanup(deviceId);

  // --- 3. Create active session (bypass admin UI via service role) ---
  const { data: sess, error: sErr } = await admin.from("sessions").insert({
    device_id: dev.id, mode: "view", state: "active",
  }).select("id").single();
  log("create session", !sErr && !!sess?.id, sErr?.message ?? sess?.id);
  if (!sess?.id) return cleanup(deviceId);
  const sessionId = sess.id;

  // --- 4. Realtime subscribe BEFORE pushes (like admin console) ---
  // Use service role for Realtime + REST here — the real admin console uses
  // an authenticated technician session (RLS: "Session owners view frames").
  // Service role bypasses RLS and still exercises the same Realtime channel.
  const pub = createClient(SUPA_URL, SUPA_SVC, { auth: { persistSession: false, autoRefreshToken: false } });
  let rtSubscribed = false;
  let rtFrame: any = null;
  let rtCursor: any = null;
  let rtFrameAt = 0, rtCursorAt = 0;
  const ch = pub.channel(`frames-${sessionId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "session_frames", filter: `session_id=eq.${sessionId}` },
      (p) => { rtFrame = p.new; rtFrameAt = Date.now(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "session_cursors", filter: `session_id=eq.${sessionId}` },
      (p) => { rtCursor = p.new; rtCursorAt = Date.now(); });
  await new Promise<void>((resolve) => {
    ch.subscribe((status) => { if (status === "SUBSCRIBED") { rtSubscribed = true; resolve(); } });
    setTimeout(resolve, 5000);
  });
  log("realtime subscribed", rtSubscribed);

  // --- 5. Push a frame + cursor from the "agent" ---
  const framePushAt = Date.now();
  const frameRes = await jpost(`/api/public/agent/session/${sessionId}/frame`,
    { frame: TINY_JPEG_B64, width: 1, height: 1 }, authHeaders);
  log("agent → frame", frameRes.status === 200, frameRes.data);

  const cursorPushAt = Date.now();
  const cursorRes = await jpost(`/api/public/agent/session/${sessionId}/cursor`,
    { x: 100, y: 50, w: 1920, h: 1080, kind: "default", visible: true }, authHeaders);
  log("agent → cursor", cursorRes.status === 200, cursorRes.data);

  // Wait up to 6s for realtime delivery.
  const waitUntil = Date.now() + 6000;
  while (Date.now() < waitUntil && (!rtFrame || !rtCursor)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  log("realtime delivered frame", !!rtFrame, rtFrame ? `${rtFrameAt - framePushAt}ms` : "timeout");
  log("realtime delivered cursor", !!rtCursor, rtCursor ? `${rtCursorAt - cursorPushAt}ms` : "timeout");

  // --- 6. REST fallback (what the console poller uses) ---
  const { data: fRow } = await pub.from("session_frames").select("frame,updated_at").eq("session_id", sessionId).maybeSingle();
  log("REST fallback frame", !!fRow?.frame && fRow.frame === TINY_JPEG_B64);
  const { data: cRow } = await pub.from("session_cursors").select("x,y,visible").eq("session_id", sessionId).maybeSingle();
  log("REST fallback cursor", cRow?.x === 100 && cRow?.y === 50 && cRow?.visible === true);

  await pub.removeChannel(ch);

  // --- 7. Teardown ---
  await admin.from("sessions").update({ state: "ended", ended_at: new Date().toISOString() }).eq("id", sessionId);
  await cleanup(deviceId);
}

async function cleanup(deviceId?: string) {
  if (!deviceId) return;
  const { data: dev } = await admin.from("devices").select("id").eq("device_id", deviceId).maybeSingle();
  if (dev?.id) {
    await admin.from("sessions").delete().eq("device_id", dev.id);
    
    await admin.from("devices").delete().eq("id", dev.id);
    console.log(`cleanup: removed device ${deviceId}`);
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
