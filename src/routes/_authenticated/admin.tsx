import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { sendTelegramNotify } from "@/lib/notify.functions";
import { getMyRole, listAdmins, createAdmin, updateAdminRole, deleteAdmin, type AppRole, type AdminRow } from "@/lib/admins.functions";
import type { Tables } from "@/integrations/supabase/types";

type Device = Tables<"devices">;
type Session = Tables<"sessions">;
type LiveFrame = { frame: string; width: number | null; height: number | null; updated_at: string };
type LiveCursor = { x: number; y: number; frame_w: number | null; frame_h: number | null; kind: string; visible: boolean; updated_at: string };

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
  head: () => ({ meta: [{ title: "Admin — ConnectLive" }] }),
});

const STALE_MS = 45_000;
const OFFLINE_MS = 180_000;

type Nav = "dashboard" | "devices" | "sessions" | "audit" | "settings" | "team";

function generatePairingCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function AdminPage() {
  const navigate = useNavigate();
  const notify = useServerFn(sendTelegramNotify);
  const fetchRole = useServerFn(getMyRole);
  const [role, setRole] = useState<AppRole | null>(null);

  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<Tables<"audit_logs">[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [liveId, setLiveId] = useState<string | null>(null);
  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null);
  const [liveCursor, setLiveCursor] = useState<LiveCursor | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [nav, setNav] = useState<Nav>("dashboard");
  const [codeModal, setCodeModal] = useState<null | { code: string; sessionId: string }>(null);
  const [sharedNote, setSharedNote] = useState<string>("");
  const [tg, setTg] = useState({ telegram_bot_token: "", telegram_chat_id: "", notify_on_session_start: true, notify_on_control_taken: true, notify_on_device_offline: true });
  const [tgSaved, setTgSaved] = useState<null | "saved" | "testing" | "test_ok" | "test_fail">(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? ""));
    void refresh();
    void loadTg();
    fetchRole().then((r) => setRole(r.role)).catch(() => setRole(null));
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
    if (!liveId) { setLiveFrame(null); setLiveCursor(null); setSharedNote(""); return; }
    let cancelled = false;
    supabase.from("session_frames").select("frame,width,height,updated_at").eq("session_id", liveId).maybeSingle()
      .then(({ data }) => { if (!cancelled && data) setLiveFrame(data as never); });
    supabase.from("session_cursors").select("x,y,frame_w,frame_h,kind,visible,updated_at").eq("session_id", liveId).maybeSingle()
      .then(({ data }) => { if (!cancelled && data) setLiveCursor(data as never); });
    const ch = supabase
      .channel(`frames-${liveId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "session_frames", filter: `session_id=eq.${liveId}` },
        (payload) => { const row = payload.new as never as LiveFrame; if (row) setLiveFrame(row); })
      .on("postgres_changes", { event: "*", schema: "public", table: "session_cursors", filter: `session_id=eq.${liveId}` },
        (payload) => { const row = payload.new as never as LiveCursor; if (row) setLiveCursor(row); })
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
    await sendInput(s.id, "release_inputs", {});
    await sendInput(s.id, "curtain_off", {});
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
    // Fire the curtain command through the same input relay the agent already polls.
    // curtain_on doubles as the watchdog heartbeat on the agent — if these stop
    // arriving for >5s, the agent auto-releases BlockInput.
    await supabase.from("session_inputs").insert({
      session_id: s.id,
      kind: nextMode === "control" ? "curtain_on" : "curtain_off",
      payload: {} as never,
    });
    const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
    void notify({
      data: {
        kind: nextMode === "control" ? "control_taken" : "control_released",
        text: nextMode === "control"
          ? `🎮 Curtain engaged on <b>${dev?.display_name ?? "device"}</b>`
          : `👤 Curtain released on <b>${dev?.display_name ?? "device"}</b>`,
      },
    });
  }

  // Enqueue a mouse/keyboard event for the agent to replay via SendInput.
  // Coordinates are normalized (0..1) relative to the rendered image.
  async function sendInput(sessionId: string, kind: string, payload: Record<string, unknown>) {
    await supabase.from("session_inputs").insert({ session_id: sessionId, kind, payload: payload as never });
  }

  // Dead-man's switch on the admin side: while we hold a control session open,
  // ping curtain_on every 1s. If this tab closes, crashes, or the network drops,
  // the agent's watchdog releases BlockInput within ~5s.
  useEffect(() => {
    if (!liveId) return;
    const s = sessions.find((x) => x.id === liveId);
    if (!s || s.mode !== "control" || !s.device_id) return;
    const ping = () => { void sendInput(s.id, "curtain_on", {}); };
    ping();
    const t = setInterval(ping, 1000);
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        void sendInput(s.id, "curtain_off", {});
      } else {
        ping();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onHide);
      // Best-effort release when the live view closes or session mode changes.
      void sendInput(s.id, "curtain_off", {});
    };
  }, [liveId, sessions]);





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
            {role === "super_admin" && <NavBtn id="team" label="Team" />}
            {role === "super_admin" && <NavBtn id="settings" label="Settings" />}
          </nav>
          <div className="mt-4 border-t border-white/10 pt-4 text-xs text-white/50">
            <div className="truncate">{userEmail}</div>
            {role && <div className="mt-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#B9CCFF]">{role.replace("_", " ")}</div>}
            <button onClick={signOut} className="mt-2 w-full rounded border border-white/15 px-2 py-1 hover:bg-white/5">Sign out</button>
          </div>
        </aside>

        {/* Main */}
        <div className="flex-1">
          <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
            <h1 className="text-lg font-semibold capitalize">{nav}</h1>
            {role !== "viewer" && (
              <button
                onClick={generateCode}
                className="rounded-lg bg-[#4F7CFF] px-4 py-2 text-sm font-medium hover:opacity-90"
              >
                + Generate meeting code
              </button>
            )}
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

            {nav === "settings" && role === "super_admin" && (
              <TelegramSettings
                tg={tg}
                setTg={setTg}
                onSave={saveTg}
                onTest={testTg}
                status={tgSaved}
              />
            )}

            {nav === "team" && role === "super_admin" && <TeamPanel />}
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
                  {s.device_id && role !== "viewer" && (
                    <button onClick={() => toggleControl(s)} className={`rounded px-3 py-1.5 text-xs font-medium ${s.mode === "control" ? "bg-red-500/90 hover:bg-red-500 text-white" : "bg-white/10 hover:bg-white/15"}`} title={s.mode === "control" ? "Release curtain and return control to the user" : "Block the user's keyboard/mouse and take control"}>
                      {s.mode === "control" ? "🔓 Release curtain" : "🔒 Curtain (take control)"}
                    </button>

                  )}
                  {role !== "viewer" && <button onClick={() => { endSession(s); setLiveId(null); }} className="rounded bg-red-500/80 px-3 py-1.5 text-xs">End</button>}
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
                      const point = getContainedImagePoint(e.currentTarget, e.clientX, e.clientY, liveFrame);
                      if (!point) return;
                      void sendInput(s.id, "mousemove", point);
                    } : undefined}
                    onMouseDown={s.mode === "control" ? (e) => {
                      const point = getContainedImagePoint(e.currentTarget, e.clientX, e.clientY, liveFrame);
                      if (!point) return;
                      e.preventDefault();
                      e.currentTarget.focus();
                      void sendInput(s.id, "mousemove", point);
                      void sendInput(s.id, "mousedown", { button: e.button });
                    } : undefined}
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
                {s.device_id && liveFrame?.frame && liveCursor && liveCursor.visible && (
                  <RemoteCursorOverlay cursor={liveCursor} frame={liveFrame} />
                )}
                {sharedNote.trim() && (
                  <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 max-w-[80%] rounded-lg border border-[#4F7CFF]/40 bg-[#1F2A44]/90 px-4 py-2 text-sm text-white shadow-lg">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[#B9CCFF]">Message shown to user</div>
                    <div className="mt-1 whitespace-pre-wrap break-words">{sharedNote}</div>
                  </div>
                )}
                <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded bg-black/60 px-2 py-1 font-mono text-[10px] text-white/70">
                  {(() => {
                    // Stream health: green <2s, amber <8s, red otherwise. Gives the
                    // admin an at-a-glance signal that the frame pipe is healthy
                    // (or lagging) without cluttering the viewport.
                    const age = liveFrame?.updated_at ? now - new Date(liveFrame.updated_at).getTime() : Infinity;
                    const cls = age < 2000 ? "bg-emerald-400" : age < 8000 ? "bg-amber-400" : "bg-rose-500";
                    const label = age < 2000 ? "live" : age < 8000 ? "lag" : "stalled";
                    return (
                      <span className="flex items-center gap-1">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />
                        <span>{label}</span>
                      </span>
                    );
                  })()}
                  <span>session {s.id.slice(0, 8)}{s.device_id ? ` · device ${s.device_id.slice(0, 8)}` : ""}</span>
                  {liveFrame?.updated_at && <span>· {new Date(liveFrame.updated_at).toLocaleTimeString()}</span>}
                </div>

                {s.mode === "control" && s.device_id && (
                  <>
                    <VirtualTrackpad
                      onMove={(dx, dy) => void sendInput(s.id, "mousemove_rel", { dx, dy })}
                      onClick={(button) => void sendInput(s.id, "click", { button })}
                    />
                    <OnScreenKeyboard
                      onKey={(vk) => sendInput(s.id, "key_sequence", { events: [{ vk, down: true }, { vk, down: false }] })}
                      onCombo={(vks) => sendInput(s.id, "key_sequence", {
                        events: [
                          ...vks.map((vk) => ({ vk, down: true })),
                          ...[...vks].reverse().map((vk) => ({ vk, down: false })),
                        ],
                      })}
                    />
                  </>
                )}
              </div>
              {s.device_id && role !== "viewer" && (
                <div className="border-t border-white/10 bg-[#0B1220] px-5 py-3">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Shared message to user</label>
                  <div className="mt-2 flex items-start gap-2">
                    <textarea
                      value={sharedNote}
                      onChange={(e) => setSharedNote(e.target.value)}
                      onBlur={() => void sendInput(s.id, "note", { text: sharedNote })}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendInput(s.id, "note", { text: sharedNote }); } }}
                      placeholder="Type a message — it appears as a banner on the user's screen. Ctrl+Enter to send."
                      rows={2}
                      className="flex-1 resize-none rounded border border-white/10 bg-[#0F172A] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[#4F7CFF] focus:outline-none"
                    />
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => void sendInput(s.id, "note", { text: sharedNote })}
                        className="rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium hover:opacity-90"
                      >
                        Send
                      </button>
                      <button
                        onClick={() => { setSharedNote(""); void sendInput(s.id, "note", { text: "" }); }}
                        className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function getContainedImagePoint(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
  frame: LiveFrame | null,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  const sourceW = frame?.width || img.naturalWidth || rect.width;
  const sourceH = frame?.height || img.naturalHeight || rect.height;
  if (!sourceW || !sourceH || !rect.width || !rect.height) return null;

  const scale = Math.min(rect.width / sourceW, rect.height / sourceH);
  const renderedW = sourceW * scale;
  const renderedH = sourceH * scale;
  const renderedLeft = rect.left + (rect.width - renderedW) / 2;
  const renderedTop = rect.top + (rect.height - renderedH) / 2;
  const x = (clientX - renderedLeft) / renderedW;
  const y = (clientY - renderedTop) / renderedH;

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function VirtualTrackpad({ onMove, onClick }: { onMove: (dx: number, dy: number) => void; onClick: (button: number) => void }) {
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<number>(() => {
    if (typeof window === "undefined") return 128;
    const raw = window.localStorage.getItem("connectlive:trackpad-size");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 96 && n <= 240 ? n : 128;
  });
  const [resizing, setResizing] = useState(false);
  const radius = size / 2 - 8;

  useEffect(() => {
    try { window.localStorage.setItem("connectlive:trackpad-size", String(size)); } catch { /* ignore */ }
  }, [size]);

  useEffect(() => {
    if (!dragging || !knob) return;
    const iv = setInterval(() => {
      const strength = Math.min(1, Math.hypot(knob.x, knob.y) / Math.max(1, radius));
      const maxStep = 26;
      const nx = Math.round((knob.x / Math.max(1, radius)) * maxStep * strength);
      const ny = Math.round((knob.y / Math.max(1, radius)) * maxStep * strength);
      if (nx !== 0 || ny !== 0) onMove(nx, ny);
    }, 50);
    return () => clearInterval(iv);
  }, [dragging, knob, onMove, radius]);

  function updateFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) { dx = (dx / dist) * radius; dy = (dy / dist) * radius; }
    setKnob({ x: dx, y: dy });
  }

  // Resize handle drag
  useEffect(() => {
    if (!resizing) return;
    const onMoveEv = (e: PointerEvent) => {
      setSize((s) => Math.max(96, Math.min(240, s - e.movementY)));
    };
    const onUp = () => setResizing(false);
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizing]);

  const knobSize = Math.max(20, Math.round(size * 0.24));

  return (
    <div className="absolute bottom-4 right-4 flex select-none flex-col items-center gap-2 rounded-xl border border-white/10 bg-black/70 p-3 backdrop-blur-md">
      <div className="flex w-full items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-widest text-white/50">Trackpad</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSize((s) => Math.max(96, s - 16))}
            className="rounded bg-white/10 px-1.5 text-xs leading-4 hover:bg-white/20"
            aria-label="Shrink trackpad"
          >−</button>
          <button
            onClick={() => setSize((s) => Math.min(240, s + 16))}
            className="rounded bg-white/10 px-1.5 text-xs leading-4 hover:bg-white/20"
            aria-label="Grow trackpad"
          >+</button>
        </div>
      </div>
      <div
        className="relative rounded-full border border-white/15 bg-white/5"
        style={{ width: size, height: size }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); updateFromPointer(e); }}
        onPointerMove={(e) => { if (dragging) updateFromPointer(e); }}
        onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false); setKnob(null); }}
        onPointerCancel={() => { setDragging(false); setKnob(null); }}
      >
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 rounded-full bg-[#4F7CFF] shadow-lg transition-transform"
          style={{
            width: knobSize,
            height: knobSize,
            transform: `translate(calc(-50% + ${knob?.x ?? 0}px), calc(-50% + ${knob?.y ?? 0}px))`,
          }}
        />
        <div
          onPointerDown={(e) => { e.stopPropagation(); setResizing(true); }}
          className="absolute -left-1 -bottom-1 h-4 w-4 cursor-nwse-resize rounded-full border border-white/30 bg-white/10 hover:bg-white/20"
          title="Drag up/down to resize"
        />
      </div>
      <div className="flex gap-2">
        <button onClick={() => onClick(0)} className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">Left click</button>
        <button onClick={() => onClick(2)} className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">Right click</button>
      </div>
    </div>
  );
}

function OnScreenKeyboard({ onKey, onCombo }: { onKey: (vk: number) => void; onCombo: (vks: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const VK = { BACK: 8, TAB: 9, ENTER: 13, CTRL: 17, ESC: 27, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, DEL: 46, A: 65, C: 67, V: 86, X: 88, Z: 90, HOME: 36, END: 35 };

  const Key = ({ label, vk, wide, tone }: { label: string; vk: number; wide?: boolean; tone?: "accent" }) => (
    <button
      onPointerDown={(e) => { e.preventDefault(); onKey(vk); }}
      className={`rounded px-2 py-1.5 text-xs font-medium transition ${
        tone === "accent" ? "bg-[#4F7CFF]/80 hover:bg-[#4F7CFF] text-white" : "bg-white/10 hover:bg-white/20 text-white/90"
      } ${wide ? "col-span-2" : ""}`}
    >
      {label}
    </button>
  );
  const Combo = ({ label, vks }: { label: string; vks: number[] }) => (
    <button
      onPointerDown={(e) => { e.preventDefault(); onCombo(vks); }}
      className="rounded bg-amber-500/20 px-2 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/30"
    >
      {label}
    </button>
  );

  return (
    <>
      {/* Toggle tab pinned to right edge */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="absolute right-0 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-l-md border border-r-0 border-white/15 bg-black/70 px-2 py-3 text-[10px] uppercase tracking-widest text-white/70 hover:bg-black/90"
        aria-label="Toggle on-screen keyboard"
      >
        <span>{open ? "›" : "‹"}</span>
        <span className="[writing-mode:vertical-rl] rotate-180">Keys</span>
      </button>

      {/* Slide-out panel */}
      <div
        className={`absolute right-0 top-0 z-10 h-full w-64 border-l border-white/10 bg-black/85 backdrop-blur-md transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <span className="text-[11px] uppercase tracking-widest text-white/60">On-screen keys</span>
          <button onClick={() => setOpen(false)} className="rounded px-1.5 text-xs text-white/60 hover:bg-white/10">✕</button>
        </div>
        <div className="grid grid-cols-3 gap-1.5 p-3">
          <Key label="Esc" vk={VK.ESC} />
          <Key label="Tab" vk={VK.TAB} />
          <Key label="Enter" vk={VK.ENTER} tone="accent" />
          <Key label="⌫ Back" vk={VK.BACK} />
          <Key label="Del" vk={VK.DEL} />
          <Key label="Home" vk={VK.HOME} />
          <Key label="End" vk={VK.END} />
          <div />
          <div />
          <div />
          <Key label="↑" vk={VK.UP} />
          <div />
          <Key label="←" vk={VK.LEFT} />
          <Key label="↓" vk={VK.DOWN} />
          <Key label="→" vk={VK.RIGHT} />
        </div>
        <div className="border-t border-white/10 px-3 py-2">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-white/50">Shortcuts</div>
          <div className="grid grid-cols-3 gap-1.5">
            <Combo label="Ctrl+A" vks={[VK.CTRL, VK.A]} />
            <Combo label="Ctrl+C" vks={[VK.CTRL, VK.C]} />
            <Combo label="Ctrl+V" vks={[VK.CTRL, VK.V]} />
            <Combo label="Ctrl+X" vks={[VK.CTRL, VK.X]} />
            <Combo label="Ctrl+Z" vks={[VK.CTRL, VK.Z]} />
          </div>
        </div>
      </div>
    </>
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

function TeamPanel() {
  const list = useServerFn(listAdmins);
  const create = useServerFn(createAdmin);
  const updateRole = useServerFn(updateAdminRole);
  const removeAdmin = useServerFn(deleteAdmin);
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", password: "", display_name: "", role: "admin" as AppRole });
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try { setRows(await list()); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await create({ data: form });
      setForm({ email: "", password: "", display_name: "", role: "admin" });
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function changeRole(user_id: string, role: AppRole) {
    try { await updateRole({ data: { user_id, role } }); await refresh(); }
    catch (e) { alert((e as Error).message); }
  }

  async function remove(user_id: string, email: string | null) {
    if (!confirm(`Remove ${email ?? "this admin"}? This cannot be undone.`)) return;
    try { await removeAdmin({ data: { user_id } }); await refresh(); }
    catch (e) { alert((e as Error).message); }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/10 bg-[#0F172A] p-5">
        <h2 className="mb-1 text-sm font-semibold">Add team member</h2>
        <p className="mb-4 text-xs text-white/50">Create a new admin account with a role. Passwords must be at least 8 characters.</p>
        <form onSubmit={submit} className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <input required placeholder="Display name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]" />
          <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]" />
          <input required type="password" minLength={8} placeholder="Password (min 8)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AppRole })} className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm">
            <option value="viewer">Viewer (read-only)</option>
            <option value="admin">Admin (live control)</option>
            <option value="super_admin">Super admin</option>
          </select>
          <button disabled={busy} className="rounded bg-[#4F7CFF] px-4 py-2 text-sm font-medium disabled:opacity-50">{busy ? "Creating…" : "Add"}</button>
        </form>
        {err && <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{err}</div>}
      </div>

      <div className="rounded-xl border border-white/10 bg-[#0F172A]">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <h2 className="text-sm font-semibold">Team members</h2>
          <button onClick={refresh} className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5">Refresh</button>
        </div>
        {loading ? (
          <div className="p-5 text-sm text-white/50">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-5 text-sm text-white/50">No team members yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40">
              <tr><th className="px-5 py-2 text-left">Name</th><th className="px-5 py-2 text-left">Email</th><th className="px-5 py-2 text-left">Role</th><th className="px-5 py-2"></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id} className="border-t border-white/5">
                  <td className="px-5 py-3">{r.display_name ?? "—"}</td>
                  <td className="px-5 py-3 text-white/70">{r.email ?? "—"}</td>
                  <td className="px-5 py-3">
                    <select
                      value={r.role ?? ""}
                      onChange={(e) => changeRole(r.user_id, e.target.value as AppRole)}
                      className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs"
                    >
                      <option value="" disabled>— none —</option>
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                      <option value="super_admin">Super admin</option>
                    </select>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button onClick={() => remove(r.user_id, r.email)} className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-red-500/20">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * SVG overlay rendering the remote cursor position independently from
 * JPEG frames (Phase-1 upgrade). Uses ResizeObserver + object-contain
 * math so the pointer lands where it truly is on the remote screen,
 * even when the container is letterboxed.
 */
function RemoteCursorOverlay({ cursor, frame }: { cursor: LiveCursor; frame: LiveFrame }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fw = cursor.frame_w ?? frame.width ?? 0;
  const fh = cursor.frame_h ?? frame.height ?? 0;
  if (!fw || !fh || !box.w || !box.h) return <div ref={ref} className="pointer-events-none absolute inset-0" />;
  const scale = Math.min(box.w / fw, box.h / fh);
  const drawW = fw * scale, drawH = fh * scale;
  const offX = (box.w - drawW) / 2, offY = (box.h - drawH) / 2;
  const px = offX + cursor.x * scale;
  const py = offY + cursor.y * scale;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      <svg
        width="20" height="24" viewBox="0 0 20 24"
        style={{ position: "absolute", left: px, top: py, transform: "translate(-2px,-2px)", cursor: cursor.kind, filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.6))" }}
      >
        <path d="M1 1 L1 19 L6 14 L9 22 L12 21 L9 13 L16 13 Z" fill="#fff" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}



