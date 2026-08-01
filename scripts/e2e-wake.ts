/**
 * End-to-end wake test.
 *
 *   1. Enroll a target device + heartbeat.
 *   2. Open an SSE stream as that device's Updater.
 *   3. Enqueue a `wake_agent` power command carrying the session to rejoin
 *      (same shape as the admin Reconnect / Wake button).
 *   4. Assert the SSE listener receives the wake within seconds.
 *   5. Simulate the Updater relaunching the agent: heartbeat surfaces the
 *      pending session invite, then the target acks the command → delivered.
 *   6. Assert the woken agent JOINS the requested session.
 *   7. Second pass with NO requested session → a fresh invite is served.
 *   8. Assert staged Wake-on-LAN failure reporting (no LAN peer online).
 *
 *   Run: API_BASE=https://zoomlite.live bun scripts/e2e-wake.ts
 */
import { createClient } from "@supabase/supabase-js";

const API = process.env.API_BASE || "http://localhost:8080";
const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPA_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SUPA_URL, SUPA_SVC, { auth: { persistSession: false } });

function log(step: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${step}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function jpost(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null; try { data = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, data, text };
}

async function enroll(name: string) {
  const r = await jpost("/api/public/agent/enroll", {
    hostname: name, os: "wake-test", displayName: name, mac: "aa:bb:cc:dd:ee:ff", agentVersion: "e2e",
  });
  if (r.status !== 200) throw new Error(`enroll ${name} failed: ${r.text}`);
  return r.data as { deviceId: string; deviceToken: string };
}

type WakeEvent = { id: string; kind: string; payload: any };

function openStream(headers: Record<string, string>, onWake: (e: WakeEvent) => void) {
  const ctrl = new AbortController();
  const ready = { value: false };
  (async () => {
    const res = await fetch(`${API}/api/public/agent/stream`, { headers, signal: ctrl.signal });
    if (!res.ok || !res.body) { console.error("stream open failed", res.status); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const dataLine = /^data: (.+)$/m.exec(chunk)?.[1];
        if (ev === "ready") ready.value = true;
        if (ev === "wake" && dataLine) { try { onWake(JSON.parse(dataLine)); } catch { /* noop */ } }
      }
    }
  })().catch((e) => { if (e?.name !== "AbortError") console.error("stream error", e?.message); });
  return { ctrl, ready };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await wait(100); }
  return pred();
}

async function main() {
  console.log(`API = ${API}`);
  const created: string[] = [];

  // ---------- 1. Target device ----------
  const target = await enroll(`wake-target-${Date.now()}`);
  created.push(target.deviceId);
  const tHeaders = { "x-device-id": target.deviceId, "x-device-token": target.deviceToken };
  const hb = await jpost("/api/public/agent/heartbeat", { lan: { subnet_v4: "10.77.0.0/24", mac: "aa:bb:cc:dd:ee:ff" } }, tHeaders);
  log("target enrolled + heartbeat", hb.status === 200);
  const { data: tRow } = await admin.from("devices").select("id").eq("device_id", target.deviceId).maybeSingle();
  if (!tRow?.id) { log("target row", false); await cleanup(created); return; }
  const targetRowId = tRow.id;

  // Pre-create the session admin wants the woken agent to rejoin.
  const { data: sess } = await admin.from("sessions").insert({ device_id: targetRowId, mode: "view", state: "invited" }).select("id").single();
  const preSessionId = sess!.id;
  log("pre-created session invite", !!preSessionId, preSessionId);

  // ---------- 2. Open Updater SSE ----------
  const wakeEvents: WakeEvent[] = [];
  const stream = openStream(tHeaders, (e) => wakeEvents.push(e));
  await waitFor(() => stream.ready.value, 4000);
  log("SSE stream ready", stream.ready.value);

  // ---------- 3. Enqueue wake_agent with session id ----------
  const { data: sysUser } = await admin.from("profiles").select("id").limit(1).maybeSingle();
  const requestedBy = sysUser?.id ?? null;
  const { data: cmd, error: cmdErr } = await admin.from("power_commands").insert({
    device_id: targetRowId,
    kind: "wake_agent",
    payload: { session_id: preSessionId },
    state: "queued",
    requested_by: requestedBy,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  }).select("id").single();
  log("wake_agent enqueued", !cmdErr && !!cmd?.id, cmdErr?.message ?? cmd?.id);
  const cmdId = cmd!.id;

  // ---------- 4. SSE delivery ----------
  const t0 = Date.now();
  const gotWake = await waitFor(() => wakeEvents.some((e) => e.id === cmdId), 4000);
  const wakeLatency = Date.now() - t0;
  log("SSE received wake", gotWake, gotWake ? `${wakeLatency}ms` : "timeout");

  // ---------- 5. Simulate Updater → Agent relaunch ----------
  //   The agent heartbeats and receives the invited session as `pending`.
  const hb2 = await jpost("/api/public/agent/heartbeat", {}, tHeaders);
  log("woken agent heartbeat", hb2.status === 200);
  const pendingSessions = hb2.data?.sessions ?? [];
  log("agent sees session invite", pendingSessions.length === 1);

  // ---------- 6. Requested session joined ----------
  log("agent joins REQUESTED session", pendingSessions[0]?.id === preSessionId,
    `expected=${preSessionId} got=${pendingSessions[0]?.id}`);

  // Ack the command as the target agent → delivered
  const ack = await jpost(`/api/public/agent/power/${cmdId}/ack`, { state: "delivered" }, tHeaders);
  log("ack sent", ack.status === 200);
  const { data: cmdAfter } = await admin.from("power_commands").select("state").eq("id", cmdId).maybeSingle();
  log("command state = delivered", cmdAfter?.state === "delivered", cmdAfter?.state);

  // ---------- 7. Wake with no session id → new invite ----------
  await admin.from("sessions").update({ state: "ended", ended_at: new Date().toISOString() }).eq("id", preSessionId);
  const { data: freshSess } = await admin.from("sessions").insert({ device_id: targetRowId, mode: "view", state: "invited" }).select("id").single();
  const hb3 = await jpost("/api/public/agent/heartbeat", {}, tHeaders);
  const freshList = hb3.data?.sessions ?? [];
  log("no-session-id wake still surfaces newest invite",
    freshList.length === 1 && freshList[0]?.id === freshSess?.id,
    { got: freshList[0]?.id, expected: freshSess?.id });

  // ---------- 8. Staged WoL failure messaging ----------
  // Simulate the admin console's Wake logic when NO peer is online:
  const { data: allDevs } = await admin.from("devices").select("id, status, metadata, last_seen_at");
  const dev = allDevs?.find((d) => d.id === targetRowId)!;
  const meta = (dev.metadata ?? {}) as Record<string, unknown>;
  let stage = "ok";
  if (!meta.lan_subnet_v4) stage = "no_subnet";
  else if (!meta.mac) stage = "no_mac";
  else {
    const peer = (allDevs ?? []).find((p) =>
      p.id !== dev.id &&
      p.status === "online" &&
      ((p.metadata ?? {}) as Record<string, unknown>).lan_subnet_v4 === meta.lan_subnet_v4,
    );
    if (!peer) stage = "no_peer";
  }
  log("staged WoL failure = no_peer", stage === "no_peer", stage);

  // ---------- Tear down ----------
  stream.ctrl.abort();
  await cleanup(created);
}

async function cleanup(deviceIds: string[]) {
  for (const did of deviceIds) {
    const { data: dev } = await admin.from("devices").select("id").eq("device_id", did).maybeSingle();
    if (dev?.id) {
      await admin.from("power_commands").delete().eq("device_id", dev.id);
      await admin.from("sessions").delete().eq("device_id", dev.id);
      await admin.from("devices").delete().eq("id", dev.id);
    }
  }
  console.log(`cleanup: removed ${deviceIds.length} device(s)`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
