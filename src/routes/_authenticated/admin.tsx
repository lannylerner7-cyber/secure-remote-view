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

const STALE_MS = 45_000;
const OFFLINE_MS = 180_000;

type Nav = "dashboard" | "devices" | "sessions" | "audit" | "settings";

function generatePairingCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function AdminPage() {
  const navigate = useNavigate();
  const notify = useServerFn(sendTelegramNotify);

  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<Tables<"audit_logs">[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [liveId, setLiveId] = useState<string | null>(null);
  const [liveFrame, setLiveFrame] = useState<{ frame: string; width: number | null; height: number | null; updated_at: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [nav, setNav] = useState<Nav>("dashboard");
  const [codeModal, setCodeModal] = useState<null | { code: string; sessionId: string }>(null);
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
    return () => { supabase.removeChannel(ch); clearInterval(t); clearInterval(clock); };
  }, []);

  // Live frame subscription: whenever an admin opens a session, we stream the
  // agent's latest screen snapshot (session_frames table, updated ~2fps).
  useEffect(() => {
    if (!liveId) { setLiveFrame(null); return; }
    let cancelled = false;
    supabase.from("session_frames").select("frame,width,height,updated_at").eq("session_id", liveId).maybeSingle()
      .then(({ data }) => { if (!cancelled && data) setLiveFrame(data as never); });
    const ch = supabase
      .channel(`frames-${liveId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "session_frames", filter: `session_id=eq.${liveId}` },
        (payload) => { const row = payload.new as never as typeof liveFrame; if (row) setLiveFrame(row); })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, [liveId]);

  async function refresh() {
    const [d, s, a] = await Promise.all([
      supabase.from("devices").select("*").order("last_seen_at", { ascending: false }),
      supabase.from("sessions").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    if (d.data) setDevices(d.data);
    if (s.data) setSessions(s.data);
    if (a.data) setAudit(a.data);
  }

  async function loadTg() {
    const { data } = await supabase.from("admin_settings").select("*").maybeSingle();
    if (data) setTg({
      telegram_bot_token: data.telegram_bot_token ?? "",
      telegram_chat_id: data.telegram_chat_id ?? "",
      notify_on_session_start: data.notify_on_session_start,
      notify_on_control_taken: data.notify_on_control_taken,
      notify_on_device_offline: data.notify_on_device_offline,
    });
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

  const presenceOf = (d: Device): "online" | "reconnecting" | "offline" => {
    const last = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
    const age = now - last;
    if (d.status === "online" && age < STALE_MS) return "online";
    if (age < OFFLINE_MS) return "reconnecting";
    return "offline";
  };

  // Generate a 6-digit code and open a pending session that any agent can join.
  async function generateCode() {
    const { data: u } = await supabase.auth.getUser();
    const code = generatePairingCode();
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        technician_id: u.user?.id,
        mode: "view",
        state: "invited",
        pairing_code: code,
        device_id: null,
      })
      .select()
      .single();
    if (error) return alert(error.message);
    if (data) setCodeModal({ code, sessionId: data.id });
  }

  async function endSession(s: Session) {
    await supabase.from("sessions").update({ state: "ended", ended_at: new Date().toISOString(), pairing_code: null }).eq("id", s.id);
    const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
    void notify({ data: { kind: "session_end", text: `⏹️ Session ended on <b>${dev?.display_name ?? "device"}</b>` } });
  }

  async function deleteSession(s: Session) {
    if (!confirm("Delete this session permanently?")) return;
    const { error } = await supabase.from("sessions").delete().eq("id", s.id);
    if (error) alert(error.message);
  }

  async function toggleControl(s: Session) {
    const nextMode = s.mode === "control" ? "view" : "control";
    await supabase.from("sessions").update({ mode: nextMode }).eq("id", s.id);
    const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
    void notify({
      data: {
        kind: nextMode === "control" ? "control_taken" : "control_released",
        text: nextMode === "control"
          ? `🎮 Control taken on <b>${dev?.display_name ?? "device"}</b>`
          : `👤 Control returned to user on <b>${dev?.display_name ?? "device"}</b>`,
      },
    });
  }

  // Enqueue a mouse/keyboard event for the agent to replay via SendInput.
  // Coordinates are normalized (0..1) relative to the rendered image.
  async function sendInput(sessionId: string, kind: string, payload: Record<string, unknown>) {
    await supabase.from("session_inputs").insert({ session_id: sessionId, kind, payload: payload as never });
  }



  function toggleSelect(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
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
    const rows = selectedDevices.map((d) => ({ device_id: d.id, event: "agent.restart_requested", detail: {} }));
    await supabase.from("audit_logs").insert(rows);
    setSelected(new Set());
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

  const reconnecting = devices.filter((d) => presenceOf(d) === "reconnecting");
  const onlineCount = devices.filter((d) => presenceOf(d) === "online").length;
  const activeSessions = sessions.filter((s) => s.state === "active" || s.state === "paused");
  const pendingSessions = sessions.filter((s) => s.state === "invited" && s.pairing_code);

  const NavBtn = ({ id, label, badge }: { id: Nav; label: string; badge?: number }) => (
    <button
      onClick={() => setNav(id)}
      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
        nav === id ? "bg-[#4F7CFF]/20 text-white" : "text-white/60 hover:bg-white/5 hover:text-white"
      }`}
    >
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-[#4F7CFF] px-1.5 py-0.5 text-[10px] font-medium text-white">{badge}</span>
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-[#0B1220] text-white">
      <div className="flex min-h-screen">
        {/* Sidebar */}
        <aside className="flex w-60 flex-col border-r border-white/10 bg-[#0F172A] p-4">
          <div className="mb-6 flex items-center gap-2 px-2">
            <span className="inline-block h-3 w-3 rounded-full bg-[#4F7CFF]" />
            <span className="font-semibold">ConnectLive</span>
          </div>
          <nav className="flex-1 space-y-1">
            <NavBtn id="dashboard" label="Dashboard" />
            <NavBtn id="devices" label="Devices" badge={onlineCount} />
            <NavBtn id="sessions" label="Sessions" badge={activeSessions.length} />
            <NavBtn id="audit" label="Audit log" />
            <NavBtn id="settings" label="Settings" />
          </nav>
          <div className="mt-4 border-t border-white/10 pt-4 text-xs text-white/50">
            <div className="truncate">{userEmail}</div>
            <button onClick={signOut} className="mt-2 w-full rounded border border-white/15 px-2 py-1 hover:bg-white/5">Sign out</button>
          </div>
        </aside>

        {/* Main */}
        <div className="flex-1">
          <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
            <h1 className="text-lg font-semibold capitalize">{nav}</h1>
            <button
              onClick={generateCode}
              className="rounded-lg bg-[#4F7CFF] px-4 py-2 text-sm font-medium hover:opacity-90"
            >
              + Generate meeting code
            </button>
          </header>

          {reconnecting.length > 0 && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-200">
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              {reconnecting.length} device{reconnecting.length > 1 ? "s" : ""} reconnecting…
            </div>
          )}

          <main className="p-6">
            {nav === "dashboard" && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                  <StatCard label="Online devices" value={onlineCount} tone="blue" />
                  <StatCard label="Active sessions" value={activeSessions.length} tone="green" />
                  <StatCard label="Pending codes" value={pendingSessions.length} tone="amber" />
                  <StatCard label="Total devices" value={devices.length} tone="slate" />
                </div>

                {pendingSessions.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">Waiting for agent</h2>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {pendingSessions.map((s) => (
                        <div key={s.id} className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
                          <div className="text-xs text-white/50">Meeting code</div>
                          <div className="my-1 font-mono text-2xl tracking-widest">{s.pairing_code}</div>
                          <div className="mb-2 text-xs text-white/40">Created {new Date(s.created_at).toLocaleTimeString()}</div>
                          <div className="flex gap-2">
                            <button onClick={() => setCodeModal({ code: s.pairing_code!, sessionId: s.id })} className="rounded bg-white/10 px-2 py-1 text-xs">Show</button>
                            <button onClick={() => deleteSession(s)} className="rounded bg-red-500/70 px-2 py-1 text-xs">Cancel</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">Recent events</h2>
                  <div className="rounded-lg border border-white/10 bg-[#1F2A44] p-4 text-xs">
                    {audit.slice(0, 10).map((a) => (
                      <div key={a.id} className="border-b border-white/5 py-1 font-mono last:border-0">
                        <span className="text-white/40">{new Date(a.created_at).toLocaleTimeString()}</span>{" "}
                        <span className="text-[#4F7CFF]">{a.event}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {nav === "devices" && (
              <DevicesTable
                devices={devices}
                presenceOf={presenceOf}
                selected={selected}
                toggleSelect={toggleSelect}
                onBulkEnd={bulkEndSessions}
                onBulkRestart={bulkRestartAgent}
                onClearSelected={() => setSelected(new Set())}
              />
            )}

            {nav === "sessions" && (
              <SessionsTable
                sessions={sessions}
                devices={devices}
                onLive={(s) => setLiveId(s.id)}
                onToggleControl={toggleControl}
                onEnd={endSession}
                onDelete={deleteSession}
                onShowCode={(s) => s.pairing_code && setCodeModal({ code: s.pairing_code, sessionId: s.id })}
              />
            )}

            {nav === "audit" && (
              <div className="rounded-lg border border-white/10 bg-[#1F2A44] p-4 text-xs">
                {audit.length === 0 ? <p className="text-white/40">No events yet.</p> : (
                  <ul className="space-y-1 font-mono">
                    {audit.map((a) => (
                      <li key={a.id} className="border-b border-white/5 py-1 last:border-0">
                        <span className="text-white/40">{new Date(a.created_at).toLocaleString()}</span>{" "}
                        <span className="text-[#4F7CFF]">{a.event}</span>{" "}
                        <span className="text-white/50">{JSON.stringify(a.detail)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {nav === "settings" && (
              <TelegramSettings
                tg={tg}
                setTg={setTg}
                onSave={saveTg}
                onTest={testTg}
                status={tgSaved}
              />
            )}
          </main>
        </div>
      </div>

      {/* Pairing code modal */}
      {codeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setCodeModal(null)}>
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#0F172A] p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-xs uppercase tracking-widest text-white/50">Meeting code</div>
            <div className="my-4 font-mono text-5xl tracking-[0.4em] text-[#B9CCFF]">{codeModal.code}</div>
            <p className="mb-5 text-sm text-white/60">
              On the target PC, open ConnectLive Agent and enter this code on the Join screen. Code stays valid until the session ends.
            </p>
            <div className="flex justify-center gap-2">
              <button onClick={() => navigator.clipboard.writeText(codeModal.code)} className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">Copy</button>
              <button onClick={() => setCodeModal(null)} className="rounded bg-[#4F7CFF] px-4 py-1.5 text-xs font-medium">Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Live view modal */}
      {liveId && (() => {
        const s = sessions.find((x) => x.id === liveId);
        if (!s) return null;
        const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
        const active = s.state === "active";
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setLiveId(null)}>
            <div className="w-full max-w-5xl overflow-hidden rounded-xl border border-white/10 bg-[#0F172A] shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[#4F7CFF] animate-pulse" : "bg-amber-400"}`} />
                  <div>
                    <div className="text-sm font-semibold">{dev?.display_name ?? "Waiting for agent…"}</div>
                    <div className="text-xs text-white/50">{s.mode === "control" ? "Remote control" : "View only"} · {s.state}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.device_id && (
                    <button onClick={() => toggleControl(s)} className={`rounded px-3 py-1.5 text-xs font-medium ${s.mode === "control" ? "bg-amber-500/90 hover:bg-amber-500 text-black" : "bg-white/10 hover:bg-white/15"}`}>
                      {s.mode === "control" ? "Resume user" : "Pause user (take control)"}
                    </button>
                  )}
                  <button onClick={() => { endSession(s); setLiveId(null); }} className="rounded bg-red-500/80 px-3 py-1.5 text-xs">End</button>
                  <button onClick={() => setLiveId(null)} className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">Close</button>
                </div>
              </div>
              <div className="relative aspect-video bg-black">
                {!s.device_id ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                    <div className="font-mono text-4xl tracking-[0.4em] text-[#B9CCFF]">{s.pairing_code}</div>
                    <div className="text-sm text-white/60">Waiting for agent to join with this code…</div>
                  </div>
                ) : liveFrame?.frame ? (
                  <img
                    src={`data:image/jpeg;base64,${liveFrame.frame}`}
                    alt="Live screen"
                    className={`absolute inset-0 h-full w-full object-contain ${s.mode === "control" ? "cursor-crosshair" : ""}`}
                    draggable={false}
                    tabIndex={s.mode === "control" ? 0 : -1}
                    onMouseMove={s.mode === "control" ? (e) => {
                      const r = (e.target as HTMLImageElement).getBoundingClientRect();
                      const x = (e.clientX - r.left) / r.width;
                      const y = (e.clientY - r.top) / r.height;
                      void sendInput(s.id, "mousemove", { x, y });
                    } : undefined}
                    onMouseDown={s.mode === "control" ? (e) => { e.preventDefault(); (e.target as HTMLImageElement).focus(); void sendInput(s.id, "mousedown", { button: e.button }); } : undefined}
                    onMouseUp={s.mode === "control" ? (e) => { e.preventDefault(); void sendInput(s.id, "mouseup", { button: e.button }); } : undefined}
                    onContextMenu={s.mode === "control" ? (e) => e.preventDefault() : undefined}
                    onWheel={s.mode === "control" ? (e) => { void sendInput(s.id, "wheel", { dy: e.deltaY }); } : undefined}
                    onKeyDown={s.mode === "control" ? (e) => { e.preventDefault(); void sendInput(s.id, "keydown", { vk: e.keyCode }); } : undefined}
                    onKeyUp={s.mode === "control" ? (e) => { e.preventDefault(); void sendInput(s.id, "keyup", { vk: e.keyCode }); } : undefined}
                  />

                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                    <div className="flex items-center gap-2 rounded-full border border-[#4F7CFF]/30 bg-[#4F7CFF]/10 px-3 py-1 text-xs text-[#B9CCFF]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#4F7CFF] animate-pulse" />
                      {active ? "Connected · waiting for first frame" : "Session paused"}
                    </div>
                    <div className="text-sm text-white/60">The agent will start streaming its screen momentarily.</div>
                  </div>
                )}
                <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/60 px-2 py-1 font-mono text-[10px] text-white/70">
                  session {s.id.slice(0, 8)}{s.device_id ? ` · device ${s.device_id.slice(0, 8)}` : ""}
                  {liveFrame?.updated_at ? ` · ${new Date(liveFrame.updated_at).toLocaleTimeString()}` : ""}
                </div>
                {s.mode === "control" && s.device_id && (
                  <VirtualTrackpad
                    onMove={(dx, dy) => void sendInput(s.id, "mousemove_rel", { dx, dy })}
                    onClick={(button) => void sendInput(s.id, "click", { button })}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function VirtualTrackpad({ onMove, onClick }: { onMove: (dx: number, dy: number) => void; onClick: (button: number) => void }) {
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging || !knob) return;
    const iv = setInterval(() => {
      // Convert knob offset into a per-tick pixel delta. Multiplier tunes speed.
      const dx = Math.round(knob.x * 0.6);
      const dy = Math.round(knob.y * 0.6);
      if (dx !== 0 || dy !== 0) onMove(dx, dy);
    }, 30);
    return () => clearInterval(iv);
  }, [dragging, knob, onMove]);

  const RADIUS = 55;
  function updateFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > RADIUS) { dx = (dx / dist) * RADIUS; dy = (dy / dist) * RADIUS; }
    setKnob({ x: dx, y: dy });
  }

  return (
    <div className="absolute bottom-4 right-4 flex select-none flex-col items-center gap-2 rounded-xl border border-white/10 bg-black/70 p-3 backdrop-blur-md">
      <div className="text-[10px] uppercase tracking-widest text-white/50">Trackpad</div>
      <div
        className="relative h-32 w-32 rounded-full border border-white/15 bg-white/5"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); updateFromPointer(e); }}
        onPointerMove={(e) => { if (dragging) updateFromPointer(e); }}
        onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false); setKnob(null); }}
        onPointerCancel={() => { setDragging(false); setKnob(null); }}
      >
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#4F7CFF] shadow-lg transition-transform"
          style={{ transform: `translate(calc(-50% + ${knob?.x ?? 0}px), calc(-50% + ${knob?.y ?? 0}px))` }}
        />
      </div>
      <div className="flex gap-2">
        <button onClick={() => onClick(0)} className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">Left click</button>
        <button onClick={() => onClick(2)} className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">Right click</button>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: "blue" | "green" | "amber" | "slate" }) {
  const bg = { blue: "bg-[#4F7CFF]/10 border-[#4F7CFF]/30", green: "bg-green-500/10 border-green-500/30", amber: "bg-amber-500/10 border-amber-500/30", slate: "bg-white/5 border-white/10" }[tone];
  return (
    <div className={`rounded-lg border p-4 ${bg}`}>
      <div className="text-xs uppercase tracking-widest text-white/50">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}

function DevicesTable({ devices, presenceOf, selected, toggleSelect, onBulkEnd, onBulkRestart, onClearSelected }: {
  devices: Device[]; presenceOf: (d: Device) => "online" | "reconnecting" | "offline";
  selected: Set<string>; toggleSelect: (id: string) => void;
  onBulkEnd: () => void; onBulkRestart: () => void; onClearSelected: () => void;
}) {
  return (
    <div>
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="text-white/60">{selected.size} selected</span>
          <button onClick={onBulkEnd} className="rounded bg-red-500/80 px-2 py-1">End sessions</button>
          <button onClick={onBulkRestart} className="rounded bg-white/10 px-2 py-1">Restart agent</button>
          <button onClick={onClearSelected} className="rounded border border-white/15 px-2 py-1">Clear</button>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-white/10 bg-[#1F2A44]">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-left text-xs uppercase text-white/50">
            <tr>
              <th className="w-8 px-4 py-2"></th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Host</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-white/40">No devices enrolled yet.</td></tr>}
            {devices.map((d) => {
              const p = presenceOf(d);
              return (
                <tr key={d.id} className="border-t border-white/5">
                  <td className="px-4 py-2"><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} /></td>
                  <td className="px-4 py-2 font-medium">{d.display_name}</td>
                  <td className="px-4 py-2 text-white/60">{d.hostname ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                      p === "online" ? "bg-green-500/15 text-green-300" : p === "reconnecting" ? "bg-amber-500/15 text-amber-300" : "bg-white/10 text-white/50"
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${p === "online" ? "bg-green-400" : p === "reconnecting" ? "bg-amber-400 animate-pulse" : "bg-white/40"}`} />
                      {p}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-white/60">{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SessionsTable({ sessions, devices, onLive, onToggleControl, onEnd, onDelete, onShowCode }: {
  sessions: Session[]; devices: Device[];
  onLive: (s: Session) => void;
  onToggleControl: (s: Session) => void;
  onEnd: (s: Session) => void;
  onDelete: (s: Session) => void;
  onShowCode: (s: Session) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#1F2A44]">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-left text-xs uppercase text-white/50">
          <tr>
            <th className="px-4 py-2">Device</th>
            <th className="px-4 py-2">Code</th>
            <th className="px-4 py-2">Mode</th>
            <th className="px-4 py-2">State</th>
            <th className="px-4 py-2">Started</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sessions.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-white/40">No sessions yet.</td></tr>}
          {sessions.map((s) => {
            const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
            return (
              <tr key={s.id} className="border-t border-white/5">
                <td className="px-4 py-2">{dev?.display_name ?? <span className="text-white/40">waiting…</span>}</td>
                <td className="px-4 py-2 font-mono text-white/70">{s.pairing_code ?? "—"}</td>
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
                <td className="px-4 py-2 text-right space-x-1">
                  {s.state === "invited" && s.pairing_code && (
                    <button onClick={() => onShowCode(s)} className="rounded bg-white/10 px-2 py-1 text-xs">Show code</button>
                  )}
                  {(s.state === "active" || s.state === "paused") && (
                    <>
                      <button onClick={() => onLive(s)} className="rounded bg-[#4F7CFF] px-2 py-1 text-xs font-medium hover:opacity-90">Live</button>
                      <button onClick={() => onToggleControl(s)} className="rounded bg-white/10 px-2 py-1 text-xs">
                        {s.mode === "control" ? "Resume" : "Pause"}
                      </button>
                      <button onClick={() => onEnd(s)} className="rounded bg-red-500/70 px-2 py-1 text-xs">End</button>
                    </>
                  )}
                  <button onClick={() => onDelete(s)} className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-red-500/20">Delete</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type TgState = { telegram_bot_token: string; telegram_chat_id: string; notify_on_session_start: boolean; notify_on_control_taken: boolean; notify_on_device_offline: boolean };

function TelegramSettings({ tg, setTg, onSave, onTest, status }: {
  tg: TgState;
  setTg: (v: TgState) => void;
  onSave: () => void; onTest: () => void;
  status: null | "saved" | "testing" | "test_ok" | "test_fail";
}) {
  return (
    <div className="max-w-lg rounded-lg border border-white/10 bg-[#1F2A44] p-6">
      <h3 className="mb-3 text-sm font-semibold">Telegram notifications</h3>
      <p className="mb-4 text-xs text-white/60">
        Create a bot with @BotFather, paste the token here, then message it once and paste your chat ID.
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
        <button onClick={onTest} className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">Send test</button>
        <div className="flex items-center gap-2">
          {status === "saved" && <span className="text-xs text-green-300">Saved</span>}
          {status === "test_ok" && <span className="text-xs text-green-300">Delivered ✓</span>}
          {status === "test_fail" && <span className="text-xs text-red-300">Failed</span>}
          {status === "testing" && <span className="text-xs text-white/60">Sending…</span>}
          <button onClick={onSave} className="rounded bg-[#4F7CFF] px-4 py-1.5 text-xs font-medium">Save</button>
        </div>
      </div>
    </div>
  );
}

