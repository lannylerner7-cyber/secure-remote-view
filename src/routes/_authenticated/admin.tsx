import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { sendTelegramNotify } from "@/lib/notify.functions";
import type { Tables } from "@/integrations/supabase/types";

type Device = Tables<"devices">;
type Session = Tables<"sessions">;

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
  head: () => ({ meta: [{ title: "Admin — ConnectLive" }] }),
});

// A device is treated as "unstable" (reconnecting) if it was online but hasn't
// heartbeated in >45s. Auto-drops to offline after 3 minutes.
const STALE_MS = 45_000;
const OFFLINE_MS = 180_000;

function AdminPage() {
  const navigate = useNavigate();
  const notify = useServerFn(sendTelegramNotify);

  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<Tables<"audit_logs">[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [liveId, setLiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [tgOpen, setTgOpen] = useState(false);
  const [tg, setTg] = useState({ telegram_bot_token: "", telegram_chat_id: "", notify_on_session_start: true, notify_on_control_taken: true, notify_on_device_offline: true });
  const [tgSaved, setTgSaved] = useState<null | "saved" | "testing" | "test_ok" | "test_fail">(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? ""));
    void refresh();
    void loadTg();

    const ch = supabase
      .channel("admin-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "audit_logs" }, refresh)
      .subscribe();

    const t = setInterval(refresh, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(t);
      clearInterval(clock);
    };
  }, []);

  async function refresh() {
    const [d, s, a] = await Promise.all([
      supabase.from("devices").select("*").order("last_seen_at", { ascending: false }),
      supabase.from("sessions").select("*").order("created_at", { ascending: false }).limit(20),
      supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(30),
    ]);
    if (d.data) setDevices(d.data);
    if (s.data) setSessions(s.data);
    if (a.data) setAudit(a.data);
  }

  async function loadTg() {
    const { data } = await supabase.from("admin_settings").select("*").maybeSingle();
    if (data) {
      setTg({
        telegram_bot_token: data.telegram_bot_token ?? "",
        telegram_chat_id: data.telegram_chat_id ?? "",
        notify_on_session_start: data.notify_on_session_start,
        notify_on_control_taken: data.notify_on_control_taken,
        notify_on_device_offline: data.notify_on_device_offline,
      });
    }
  }

  async function saveTg() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("admin_settings").upsert({ user_id: u.user.id, ...tg, updated_at: new Date().toISOString() });
    setTgSaved("saved");
    setTimeout(() => setTgSaved(null), 2000);
  }

  async function testTg() {
    setTgSaved("testing");
    const r = await notify({ data: { kind: "session_start", text: "✅ <b>ConnectLive</b> Telegram notifications are working." } });
    setTgSaved(r.ok ? "test_ok" : "test_fail");
    setTimeout(() => setTgSaved(null), 3000);
  }

  // Derive presence with stale/reconnecting inference
  const presenceOf = (d: Device): "online" | "reconnecting" | "offline" => {
    const last = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
    const age = now - last;
    if (d.status === "online" && age < STALE_MS) return "online";
    if (age < OFFLINE_MS) return "reconnecting";
    return "offline";
  };

  async function startLive(device: Device) {
    const existing = sessions.find(
      (x) => x.device_id === device.id && (x.state === "active" || x.state === "paused" || x.state === "invited"),
    );
    if (existing) {
      if (existing.state !== "active") {
        await supabase.from("sessions").update({ state: "active" }).eq("id", existing.id);
      }
      setLiveId(existing.id);
      return;
    }
    const { data: u } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        device_id: device.id,
        technician_id: u.user?.id,
        mode: "view",
        state: "active",
        consent_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) return alert(error.message);
    if (data) {
      setLiveId(data.id);
      void notify({ data: { kind: "session_start", text: `🖥️ Session started on <b>${device.display_name}</b> (${device.hostname ?? "—"})` } });
    }
  }

  async function endSession(s: Session) {
    await supabase.from("sessions").update({ state: "ended", ended_at: new Date().toISOString() }).eq("id", s.id);
    const dev = devices.find((d) => d.id === s.device_id);
    void notify({ data: { kind: "session_end", text: `⏹️ Session ended on <b>${dev?.display_name ?? "device"}</b>` } });
  }

  async function toggleControl(s: Session) {
    const nextMode = s.mode === "control" ? "view" : "control";
    await supabase.from("sessions").update({ mode: nextMode }).eq("id", s.id);
    const dev = devices.find((d) => d.id === s.device_id);
    void notify({
      data: {
        kind: nextMode === "control" ? "control_taken" : "control_released",
        text: nextMode === "control"
          ? `🎮 Control taken on <b>${dev?.display_name ?? "device"}</b>`
          : `👤 Control returned to user on <b>${dev?.display_name ?? "device"}</b>`,
      },
    });
  }

  // ---- Bulk actions --------------------------------------------------
  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  const selectedDevices = useMemo(() => devices.filter((d) => selected.has(d.id)), [devices, selected]);

  async function bulkEndSessions() {
    if (selectedDevices.length === 0) return;
    if (!confirm(`End all active sessions on ${selectedDevices.length} device(s)?`)) return;
    const ids = selectedDevices.map((d) => d.id);
    const { data: open } = await supabase.from("sessions").select("id, device_id").in("device_id", ids).in("state", ["active", "paused", "invited"]);
    if (open && open.length) {
      await supabase.from("sessions").update({ state: "ended", ended_at: new Date().toISOString() }).in("id", open.map((x) => x.id));
    }
    setSelected(new Set());
  }

  async function bulkRestartAgent() {
    if (selectedDevices.length === 0) return;
    if (!confirm(`Signal ${selectedDevices.length} agent(s) to restart?`)) return;
    // Broadcast is picked up by agents on next heartbeat via audit_logs feed.
    const rows = selectedDevices.map((d) => ({ device_id: d.id, event: "agent.restart_requested", detail: {} }));
    await supabase.from("audit_logs").insert(rows);
    setSelected(new Set());
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

  const reconnecting = devices.filter((d) => presenceOf(d) === "reconnecting");

  return (
    <div className="min-h-screen bg-[#0F172A] text-white">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="inline-block h-3 w-3 rounded-full bg-[#4F7CFF]" />
            <span className="font-semibold">ConnectLive · Admin</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-white/60">
            <button onClick={() => setTgOpen(true)} className="rounded border border-white/15 px-2 py-1 hover:bg-white/5">Telegram</button>
            <span>{userEmail}</span>
            <button onClick={signOut} className="rounded border border-white/15 px-2 py-1 hover:bg-white/5">Sign out</button>
          </div>
        </div>
      </header>

      {/* Reconnect banner */}
      {reconnecting.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/10">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-2 text-xs text-amber-200">
            <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
            <span>
              {reconnecting.length} device{reconnecting.length > 1 ? "s" : ""} reconnecting…
            </span>
            <span className="text-amber-200/60">
              Auto-drop to offline in {Math.max(0, Math.round((OFFLINE_MS - (now - new Date(reconnecting[0].last_seen_at!).getTime())) / 1000))}s
            </span>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-white/60">Devices ({devices.length})</h2>
            {selected.size > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-white/60">{selected.size} selected</span>
                <button onClick={bulkEndSessions} className="rounded bg-red-500/80 px-2 py-1">End sessions</button>
                <button onClick={bulkRestartAgent} className="rounded bg-white/10 px-2 py-1">Restart agent</button>
                <button onClick={() => setSelected(new Set())} className="rounded border border-white/15 px-2 py-1">Clear</button>
              </div>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-white/10 bg-[#1F2A44]">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-left text-xs uppercase text-white/50">
                <tr>
                  <th className="w-8 px-4 py-2"></th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Host</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Last seen</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-white/40">No devices enrolled yet.</td></tr>
                )}
                {devices.map((d) => {
                  const p = presenceOf(d);
                  return (
                    <tr key={d.id} className="border-t border-white/5">
                      <td className="px-4 py-2">
                        <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} />
                      </td>
                      <td className="px-4 py-2 font-medium">{d.display_name}</td>
                      <td className="px-4 py-2 text-white/60">{d.hostname ?? "—"}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                          p === "online" ? "bg-green-500/15 text-green-300" :
                          p === "reconnecting" ? "bg-amber-500/15 text-amber-300" :
                          "bg-white/10 text-white/50"
                        }`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${
                            p === "online" ? "bg-green-400" : p === "reconnecting" ? "bg-amber-400 animate-pulse" : "bg-white/40"
                          }`} />
                          {p}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-white/60">{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => startLive(d)}
                          disabled={p === "offline"}
                          className="rounded bg-[#4F7CFF] px-3 py-1 text-xs font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Live view
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">Sessions</h2>
          <div className="overflow-hidden rounded-lg border border-white/10 bg-[#1F2A44]">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-left text-xs uppercase text-white/50">
                <tr>
                  <th className="px-4 py-2">Device</th>
                  <th className="px-4 py-2">Mode</th>
                  <th className="px-4 py-2">State</th>
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-white/40">No sessions yet.</td></tr>
                )}
                {sessions.map((s) => {
                  const dev = devices.find((d) => d.id === s.device_id);
                  return (
                    <tr key={s.id} className="border-t border-white/5">
                      <td className="px-4 py-2">{dev?.display_name ?? s.device_id.slice(0, 8)}</td>
                      <td className="px-4 py-2 text-white/70">{s.mode}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                          s.state === "active" ? "bg-[#4F7CFF]/20 text-[#B9CCFF]" :
                          s.state === "paused" ? "bg-amber-500/15 text-amber-300" :
                          s.state === "invited" ? "bg-white/10 text-white/70" :
                          "bg-white/5 text-white/40"
                        }`}>
                          {s.state === "active" && <span className="h-1.5 w-1.5 rounded-full bg-[#4F7CFF] animate-pulse" />}
                          {s.state}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-white/60">{new Date(s.created_at).toLocaleTimeString()}</td>
                      <td className="px-4 py-2 text-right">
                        {(s.state === "active" || s.state === "paused") && (
                          <>
                            <button onClick={() => setLiveId(s.id)} className="mr-2 rounded bg-[#4F7CFF] px-2 py-1 text-xs font-medium hover:opacity-90">Live view</button>
                            <button onClick={() => toggleControl(s)} className="mr-2 rounded bg-white/10 px-2 py-1 text-xs">
                              {s.mode === "control" ? "Resume user" : "Pause user"}
                            </button>
                            <button onClick={() => endSession(s)} className="rounded bg-red-500/80 px-2 py-1 text-xs">End</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">Audit</h2>
          <div className="rounded-lg border border-white/10 bg-[#1F2A44] p-4 text-xs">
            {audit.length === 0 ? (
              <p className="text-white/40">No events yet.</p>
            ) : (
              <ul className="space-y-1 font-mono">
                {audit.map((a) => (
                  <li key={a.id} className="text-white/70">
                    <span className="text-white/40">{new Date(a.created_at).toLocaleTimeString()}</span>{" "}
                    <span className="text-[#4F7CFF]">{a.event}</span>{" "}
                    <span className="text-white/50">{JSON.stringify(a.detail)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      {/* Telegram settings modal */}
      {tgOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setTgOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#0F172A] p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-sm font-semibold">Telegram notifications</h3>
            <p className="mb-4 text-xs text-white/60">
              Create a bot with @BotFather, paste the token here, then message it once and paste your chat ID from
              https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates.
            </p>
            <label className="block text-xs text-white/60">Bot token</label>
            <input value={tg.telegram_bot_token} onChange={(e) => setTg({ ...tg, telegram_bot_token: e.target.value })}
              className="mb-3 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-sm" placeholder="123456:ABC-DEF..." />
            <label className="block text-xs text-white/60">Chat ID</label>
            <input value={tg.telegram_chat_id} onChange={(e) => setTg({ ...tg, telegram_chat_id: e.target.value })}
              className="mb-4 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-sm" placeholder="123456789" />

            <div className="mb-4 space-y-2 text-xs">
              <label className="flex items-center gap-2"><input type="checkbox" checked={tg.notify_on_session_start} onChange={(e) => setTg({ ...tg, notify_on_session_start: e.target.checked })} /> Notify on session start</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={tg.notify_on_control_taken} onChange={(e) => setTg({ ...tg, notify_on_control_taken: e.target.checked })} /> Notify on control taken / released</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={tg.notify_on_device_offline} onChange={(e) => setTg({ ...tg, notify_on_device_offline: e.target.checked })} /> Notify on device offline</label>
            </div>

            <div className="flex items-center justify-between gap-2">
              <button onClick={testTg} className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">Send test</button>
              <div className="flex items-center gap-2">
                {tgSaved === "saved" && <span className="text-xs text-green-300">Saved</span>}
                {tgSaved === "test_ok" && <span className="text-xs text-green-300">Delivered ✓</span>}
                {tgSaved === "test_fail" && <span className="text-xs text-red-300">Failed — check token/chat id</span>}
                {tgSaved === "testing" && <span className="text-xs text-white/60">Sending…</span>}
                <button onClick={() => setTgOpen(false)} className="rounded border border-white/15 px-3 py-1.5 text-xs">Close</button>
                <button onClick={saveTg} className="rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live view modal */}
      {liveId && (() => {
        const s = sessions.find((x) => x.id === liveId);
        if (!s) return null;
        const dev = devices.find((d) => d.id === s.device_id);
        const active = s.state === "active";
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setLiveId(null)}>
            <div className="w-full max-w-5xl overflow-hidden rounded-xl border border-white/10 bg-[#0F172A] shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[#4F7CFF] animate-pulse" : "bg-amber-400"}`} />
                  <div>
                    <div className="text-sm font-semibold">{dev?.display_name ?? "Device"}</div>
                    <div className="text-xs text-white/50">{s.mode === "control" ? "Remote control" : "View only"} · {s.state}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleControl(s)} className={`rounded px-3 py-1.5 text-xs font-medium ${s.mode === "control" ? "bg-amber-500/90 hover:bg-amber-500 text-black" : "bg-white/10 hover:bg-white/15"}`}>
                    {s.mode === "control" ? "Resume user" : "Pause user (take control)"}
                  </button>
                  <button onClick={() => { endSession(s); setLiveId(null); }} className="rounded bg-red-500/80 px-3 py-1.5 text-xs">End session</button>
                  <button onClick={() => setLiveId(null)} className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">Close</button>
                </div>
              </div>
              <div className="relative aspect-video bg-gradient-to-br from-[#1F2A44] to-[#0F172A]" tabIndex={0}
                   onMouseMove={() => { /* input relay wire-up point */ }}>
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                  <div className="flex items-center gap-2 rounded-full border border-[#4F7CFF]/30 bg-[#4F7CFF]/10 px-3 py-1 text-xs text-[#B9CCFF]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#4F7CFF] animate-pulse" />
                    {active ? "Connected · streaming frames" : "Session paused"}
                  </div>
                  <div className="text-sm text-white/70">Waiting for agent WebRTC track…</div>
                </div>
                <div className="absolute bottom-3 left-3 rounded bg-black/50 px-2 py-1 font-mono text-[10px] text-white/60">
                  session {s.id.slice(0, 8)} · device {s.device_id.slice(0, 8)}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
