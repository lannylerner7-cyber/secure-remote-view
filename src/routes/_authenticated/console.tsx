import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { sendTelegramNotify } from "@/lib/notify.functions";
import { getMyRole, listAdmins, createAdmin, updateAdminRole, deleteAdmin, type AppRole, type AdminRow } from "@/lib/admins.functions";
import { broadcastNotification, sendNotification, type NotificationSeverity } from "@/lib/notifications.functions";
import { NotificationBell } from "@/components/NotificationBell";
import { PaymentsPanel } from "@/components/PaymentsPanel";
import { startWebRtcLive, type WebRtcLive } from "@/lib/webrtc-live";
import type { Tables } from "@/integrations/supabase/types";

type Device = Tables<"devices">;
type Session = Tables<"sessions">;
type LiveFrame = { frame: string; width: number | null; height: number | null; updated_at: string };
type LiveCursor = { x: number; y: number; frame_w: number | null; frame_h: number | null; kind: string; visible: boolean; updated_at: string };

const NAV_VALUES = ["dashboard", "devices", "sessions", "audit", "settings", "team", "payments"] as const;

export const Route = createFileRoute("/_authenticated/console")({
  component: AdminPage,
  head: () => ({ meta: [{ title: "Admin — ConnectLive" }] }),
  validateSearch: (raw: Record<string, unknown>): { tab?: Nav } => {
    const t = typeof raw.tab === "string" ? raw.tab : undefined;
    return t && (NAV_VALUES as readonly string[]).includes(t) ? { tab: t as Nav } : {};
  },
});

// Agent heartbeat cadence = 15s; backend flags reconnect after a 60s gap.
// Give one missed beat of grace before "reconnecting", and match the backend
// threshold for hard "offline".
const STALE_MS = 30_000;
const OFFLINE_MS = 75_000;

type Nav = "dashboard" | "devices" | "sessions" | "audit" | "settings" | "team" | "payments";


function keyToVirtualKey(e: React.KeyboardEvent<HTMLElement>): number | null {
  const named: Record<string, number> = {
    Backspace: 0x08,
    Tab: 0x09,
    Enter: 0x0d,
    Escape: 0x1b,
    PageUp: 0x21,
    PageDown: 0x22,
    End: 0x23,
    Home: 0x24,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    Insert: 0x2d,
    Delete: 0x2e,
    Shift: e.code === "ShiftRight" ? 0xa1 : 0xa0,
    Control: e.code === "ControlRight" ? 0xa3 : 0xa2,
    Alt: e.code === "AltRight" ? 0xa5 : 0xa4,
    Meta: e.code === "MetaRight" ? 0x5c : 0x5b,
  };
  if (named[e.key]) return named[e.key];

  const keyMatch = /^Key([A-Z])$/.exec(e.code);
  if (keyMatch) return keyMatch[1].charCodeAt(0);
  const digitMatch = /^Digit([0-9])$/.exec(e.code);
  if (digitMatch) return digitMatch[1].charCodeAt(0);
  const numpadMatch = /^Numpad([0-9])$/.exec(e.code);
  if (numpadMatch) return 0x60 + Number(numpadMatch[1]);

  const byCode: Record<string, number> = {
    Space: 0x20,
    NumpadEnter: 0x0d,
    NumpadMultiply: 0x6a,
    NumpadAdd: 0x6b,
    NumpadSubtract: 0x6d,
    NumpadDecimal: 0x6e,
    NumpadDivide: 0x6f,
    F1: 0x70,
    F2: 0x71,
    F3: 0x72,
    F4: 0x73,
    F5: 0x74,
    F6: 0x75,
    F7: 0x76,
    F8: 0x77,
    F9: 0x78,
    F10: 0x79,
    F11: 0x7a,
    F12: 0x7b,
  };
  return byCode[e.code] ?? null;
}

function AdminPage() {
  const navigate = useNavigate();
  const notify = useServerFn(sendTelegramNotify);
  const fetchRole = useServerFn(getMyRole);
  const [role, setRole] = useState<AppRole | null>(null);
  const liveSurfaceRef = useRef<HTMLDivElement | null>(null);
  const rtcRef = useRef<WebRtcLive | null>(null);
  const lastScreenMoveAtRef = useRef(0);
  const mouseButtonDownRef = useRef(false);

  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<Tables<"audit_logs">[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [userId, setUserId] = useState<string | null>(null);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null);
  const [liveCursor, setLiveCursor] = useState<LiveCursor | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const search = Route.useSearch();
  const [nav, setNav] = useState<Nav>(search.tab ?? "dashboard");
  const [sharedNote, setSharedNote] = useState<string>("");
  const [tg, setTg] = useState({ telegram_bot_token: "", telegram_chat_id: "", notify_on_session_start: true, notify_on_control_taken: true, notify_on_device_offline: true });
  const [tgSaved, setTgSaved] = useState<null | "saved" | "testing" | "test_ok" | "test_fail">(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => { setUserEmail(data.user?.email ?? ""); setUserId(data.user?.id ?? null); });
    void refresh();
    void loadTg();
    fetchRole().then((r) => {
      setRole(r.role);
      if (nav === "payments" && r.role !== "admin" && r.role !== "super_admin") {
        setNav("dashboard");
      }
    }).catch(() => setRole(null));
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

  useEffect(() => {
    if (!liveId) {
      rtcRef.current?.close();
      rtcRef.current = null;
      return;
    }
    const live = startWebRtcLive(liveId);
    rtcRef.current = live;
    return () => {
      if (rtcRef.current === live) rtcRef.current = null;
      live.close();
    };
  }, [liveId]);

  useEffect(() => {
    if (!liveId) return;
    const s = sessions.find((x) => x.id === liveId);
    if (s?.mode === "control") {
      requestAnimationFrame(() => liveSurfaceRef.current?.focus({ preventScroll: true }));
    }
  }, [liveId, sessions]);

  // Keep the live surface focused across tab switches, notification pop-ups,
  // and OSK re-renders — otherwise Enter/keys silently route to the browser
  // after long control sessions.
  useEffect(() => {
    if (!liveId) return;
    const s = sessions.find((x) => x.id === liveId);
    if (s?.mode !== "control") return;
    const restore = () => {
      if (document.visibilityState === "visible") {
        requestAnimationFrame(() => liveSurfaceRef.current?.focus({ preventScroll: true }));
      }
    };
    window.addEventListener("focus", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      window.removeEventListener("focus", restore);
      document.removeEventListener("visibilitychange", restore);
    };
  }, [liveId, sessions]);

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

  // Open a session on a specific enrolled device. The agent picks it up
  // via /heartbeat within ~5s (no PIN, no user prompt) and prompts the
  // local user for consent per the standing-consent model.
  async function connectDevice(d: Device) {
    const { data: u } = await supabase.auth.getUser();
    const { data: existing } = await supabase
      .from("sessions")
      .select("id")
      .eq("device_id", d.id)
      .in("state", ["invited", "consented", "active", "paused"])
      .maybeSingle();
    if (existing) { setLiveId(existing.id); return; }
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        technician_id: u.user?.id,
        mode: "view",
        state: "invited",
        device_id: d.id,
      })
      .select()
      .single();
    if (error) return alert(error.message);
    if (data) setLiveId(data.id);
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

  async function requestReconnect(s: Session) {
    if (!s.device_id) return;
    await sendInput(s.id, "curtain_off", {});
    const { error } = await supabase
      .from("sessions")
      .update({ state: "active", mode: "view", updated_at: new Date().toISOString() })
      .eq("id", s.id);
    if (error) return alert(error.message);
    setLiveId(s.id);
    const dev = devices.find((d) => d.id === s.device_id);
    void notify({ data: { kind: "session_start", text: `🔁 Waiting for <b>${dev?.display_name ?? "device"}</b> to reconnect to the existing session.` } });
    void refresh();
  }

  // Enqueue a mouse/keyboard event for the agent to replay via SendInput.
  // Coordinates are normalized (0..1) relative to the rendered image.
  async function sendInput(sessionId: string, kind: string, payload: Record<string, unknown>) {
    // Continuous mouse streams stay RTC-only to avoid flooding the DB.
    // Discrete "one-shot" events (clicks, keys, text) go BOTH via RTC and DB
    // so an unhealthy data channel can never silently drop a keystroke.
    const continuous = kind === "mousemove" || kind === "mousemove_rel" || kind === "wheel";
    const sentRealtime = rtcRef.current?.sendInput({ kind, payload }) ?? false;
    if (continuous && sentRealtime) return;
    await supabase.from("session_inputs").insert({ session_id: sessionId, kind, payload: payload as never });
  }

  function focusLiveSurface() {
    requestAnimationFrame(() => liveSurfaceRef.current?.focus({ preventScroll: true }));
  }

  function sendKeyboardDown(sessionId: string, e: React.KeyboardEvent<HTMLElement>, updateEcho = false) {
    if (e.nativeEvent.isComposing) return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable) {
      e.preventDefault();
      void sendInput(sessionId, "unicode_text", { text: e.key });
      if (updateEcho) setSharedNote((v) => (v + e.key).slice(-240));
      return;
    }

    const vk = keyToVirtualKey(e);
    if (!vk) return;
    e.preventDefault();
    if (updateEcho && e.key === "Backspace") setSharedNote((v) => v.slice(0, -1));
    void sendInput(sessionId, "keydown", { vk });
  }

  function sendKeyboardUp(sessionId: string, e: React.KeyboardEvent<HTMLElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    const vk = keyToVirtualKey(e);
    if (!vk) return;
    e.preventDefault();
    void sendInput(sessionId, "keyup", { vk });
  }

  function pasteToRemote(sessionId: string, e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    void sendInput(sessionId, "unicode_text", { text });
    setSharedNote((v) => (v + text).slice(-240));
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
    navigate({ to: "/admin" });
  }

  const reconnecting = devices.filter((d) => presenceOf(d) === "reconnecting");
  const onlineCount = devices.filter((d) => presenceOf(d) === "online").length;
  const activeSessions = sessions.filter((s) => s.state === "active" || s.state === "paused");
  const pendingSessions = sessions.filter((s) => s.state === "invited");

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
            {(role === "super_admin" || role === "admin") && <NavBtn id="payments" label="Payments" />}
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
            <div className="flex items-center gap-3">
              <NotificationBell userId={userId} />
              {role !== "viewer" && (
                <span className="text-xs text-white/50">
                  Devices auto-enroll via Deployment Key — click <b>Connect</b> on any online device.
                </span>
              )}
            </div>
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
                  <StatCard label="Waiting for consent" value={pendingSessions.length} tone="amber" />
                  <StatCard label="Total devices" value={devices.length} tone="slate" />
                </div>

                {pendingSessions.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">Waiting for consent</h2>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {pendingSessions.map((s) => {
                        const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
                        return (
                          <div key={s.id} className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
                            <div className="text-xs text-white/50">Device</div>
                            <div className="my-1 truncate text-base font-medium">{dev?.display_name ?? "unknown"}</div>
                            <div className="mb-2 text-xs text-white/40">Invited {new Date(s.created_at).toLocaleTimeString()}</div>
                            <button onClick={() => deleteSession(s)} className="rounded bg-red-500/70 px-2 py-1 text-xs">Cancel</button>
                          </div>
                        );
                      })}
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
                onConnect={connectDevice}
                canConnect={role !== "viewer"}
              />
            )}

            {nav === "sessions" && (
              <SessionsTable
                sessions={sessions}
                devices={devices}
                onLive={(s) => setLiveId(s.id)}
                onToggleControl={toggleControl}
                onReconnect={requestReconnect}
                onEnd={endSession}
                onDelete={deleteSession}
                presenceOf={presenceOf}
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

            {nav === "payments" && (role === "super_admin" || role === "admin") && (
              <PaymentsPanel isSuperAdmin={role === "super_admin"} />
            )}
          </main>
        </div>
      </div>


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
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
                    Session has no device attached.
                  </div>
                ) : liveFrame?.frame ? (
                  <div
                    ref={liveSurfaceRef}
                    tabIndex={s.mode === "control" ? 0 : -1}
                    className={`absolute inset-0 outline-none ${s.mode === "control" ? "cursor-crosshair" : ""}`}
                    onMouseMove={s.mode === "control" ? (e) => {
                      const nowMs = performance.now();
                      // Skip throttle while a button is held so drag-select captures every point.
                      if (!mouseButtonDownRef.current && nowMs - lastScreenMoveAtRef.current < 24) return;
                      lastScreenMoveAtRef.current = nowMs;
                      const point = getContainedImagePoint(e.currentTarget, e.clientX, e.clientY, liveFrame);
                      if (!point) return;
                      void sendInput(s.id, "mousemove", point);
                    } : undefined}
                    onMouseDown={s.mode === "control" ? (e) => {
                      const point = getContainedImagePoint(e.currentTarget, e.clientX, e.clientY, liveFrame);
                      if (!point) return;
                      e.preventDefault();
                      focusLiveSurface();
                      mouseButtonDownRef.current = true;
                      void sendInput(s.id, "mousemove", point);
                      void sendInput(s.id, "mousedown", { button: e.button });
                    } : undefined}
                    onMouseUp={s.mode === "control" ? (e) => { e.preventDefault(); mouseButtonDownRef.current = false; void sendInput(s.id, "mouseup", { button: e.button }); } : undefined}
                    onMouseLeave={s.mode === "control" ? () => { mouseButtonDownRef.current = false; } : undefined}
                    onContextMenu={s.mode === "control" ? (e) => e.preventDefault() : undefined}
                    onWheel={s.mode === "control" ? (e) => { e.preventDefault(); void sendInput(s.id, "wheel", { dy: e.deltaY }); } : undefined}
                    onKeyDown={s.mode === "control" ? (e) => sendKeyboardDown(s.id, e) : undefined}
                    onKeyUp={s.mode === "control" ? (e) => sendKeyboardUp(s.id, e) : undefined}
                  >
                    <img
                      src={`data:image/jpeg;base64,${liveFrame.frame}`}
                      alt="Live screen"
                      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                      draggable={false}
                    />
                  </div>
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
                      onClick={(button) => { void sendInput(s.id, "click", { button }); focusLiveSurface(); }}
                      onDoubleClick={() => {
                        void sendInput(s.id, "click", { button: 0 });
                        window.setTimeout(() => { void sendInput(s.id, "click", { button: 0 }); }, 60);
                        focusLiveSurface();
                      }}
                      onNudge={(dx, dy) => { void sendInput(s.id, "mousemove_rel", { dx, dy }); }}
                    />
                    <OnScreenKeyboard
                      onKey={(vk) => { void sendInput(s.id, "key_sequence", { events: [{ vk, down: true }, { vk, down: false }] }); focusLiveSurface(); }}
                      onCombo={(vks) => {
                        void sendInput(s.id, "key_sequence", {
                          events: [
                            ...vks.map((vk) => ({ vk, down: true })),
                            ...[...vks].reverse().map((vk) => ({ vk, down: false })),
                          ],
                        });
                        focusLiveSurface();
                      }}
                    />

                  </>
                )}
              </div>
              {s.device_id && role !== "viewer" && s.mode === "control" && (
                <div className="border-t border-white/10 bg-[#0B1220] px-5 py-3">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Typing tunnel to remote PC</label>
                  <div className="mt-2 flex items-start gap-2">
                    <textarea
                      value={sharedNote}
                      onChange={() => { /* input is mirrored from key events so shortcuts never affect this local field */ }}
                      onPaste={(e) => pasteToRemote(s.id, e)}
                      onKeyDown={(e) => sendKeyboardDown(s.id, e, true)}
                      onKeyUp={(e) => sendKeyboardUp(s.id, e)}
                      placeholder="Type here to send keystrokes to the focused app on the remote PC."
                      rows={2}
                      className="flex-1 resize-none rounded border border-white/10 bg-[#0F172A] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[#4F7CFF] focus:outline-none"
                    />
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => { if (sharedNote) void sendInput(s.id, "unicode_text", { text: sharedNote }); }}
                        className="rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium hover:opacity-90"
                      >
                        Type
                      </button>
                      <button
                        onClick={() => setSharedNote("")}
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
  el: HTMLElement,
  clientX: number,
  clientY: number,
  frame: LiveFrame | null,
): { x: number; y: number } | null {
  const rect = el.getBoundingClientRect();
  const sourceW = frame?.width || rect.width;
  const sourceH = frame?.height || rect.height;
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

function VirtualTrackpad({
  onMove,
  onClick,
  onDoubleClick,
  onNudge,
}: {
  onMove: (dx: number, dy: number) => void;
  onClick: (button: number) => void;
  onDoubleClick: () => void;
  onNudge: (dx: number, dy: number) => void;
}) {
  const nudgeTimerRef = useRef<number | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<number>(() => {
    if (typeof window === "undefined") return 128;
    const raw = window.localStorage.getItem("connectlive:trackpad-size");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 96 && n <= 240 ? n : 128;
  });
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("connectlive:trackpad-open") !== "0";
  });
  const [resizing, setResizing] = useState(false);
  const radius = size / 2 - 8;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem("connectlive:trackpad-pos");
      if (raw) { const p = JSON.parse(raw); if (typeof p?.x === "number" && typeof p?.y === "number") return p; }
    } catch { /* ignore */ }
    return null;
  });
  const dragPadRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem("connectlive:trackpad-size", String(size)); } catch { /* ignore */ }
  }, [size]);
  useEffect(() => {
    try { window.localStorage.setItem("connectlive:trackpad-open", open ? "1" : "0"); } catch { /* ignore */ }
  }, [open]);
  useEffect(() => {
    if (!pos) return;
    try { window.localStorage.setItem("connectlive:trackpad-pos", JSON.stringify(pos)); } catch { /* ignore */ }
  }, [pos]);

  const clampPos = (x: number, y: number) => {
    const el = panelRef.current;
    const w = el?.offsetWidth ?? size + 24;
    const h = el?.offsetHeight ?? size + 120;
    const maxX = Math.max(0, window.innerWidth - w - 4);
    const maxY = Math.max(0, window.innerHeight - h - 4);
    return { x: Math.max(4, Math.min(maxX, x)), y: Math.max(4, Math.min(maxY, y)) };
  };
  const onPanelDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const el = panelRef.current;
    const rect = el?.getBoundingClientRect();
    const origX = pos?.x ?? (rect?.left ?? 0);
    const origY = pos?.y ?? (rect?.top ?? 0);
    dragPadRef.current = { startX: e.clientX, startY: e.clientY, origX, origY };
  };
  const onPanelDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragPadRef.current;
    if (!d) return;
    setPos(clampPos(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY)));
  };
  const onPanelDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    dragPadRef.current = null;
  };

  useEffect(() => {
    if (!dragging || !knob) return;
    const iv = setInterval(() => {
      const strength = Math.min(1, Math.hypot(knob.x, knob.y) / Math.max(1, radius));
      const maxStep = 56;
      const curve = 0.35 + strength * 0.9;
      const nx = Math.round((knob.x / Math.max(1, radius)) * maxStep * curve);
      const ny = Math.round((knob.y / Math.max(1, radius)) * maxStep * curve);
      if (nx !== 0 || ny !== 0) onMove(nx, ny);
    }, 24);
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

  // Press-and-hold cursor nudge. First tick fires immediately, then a
  // 24ms interval keeps sending the same delta with a mild acceleration
  // curve while the pointer stays down.
  const startNudge = (dx: number, dy: number) => {
    if (nudgeTimerRef.current != null) window.clearInterval(nudgeTimerRef.current);
    onNudge(dx, dy);
    let ticks = 0;
    nudgeTimerRef.current = window.setInterval(() => {
      ticks += 1;
      const accel = Math.min(4, 1 + ticks * 0.15);
      onNudge(Math.round(dx * accel), Math.round(dy * accel));
    }, 24);
  };
  const stopNudge = () => {
    if (nudgeTimerRef.current != null) {
      window.clearInterval(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
  };
  const hideTrackpad = () => {
    stopNudge();
    dragPadRef.current = null;
    setDragging(false);
    setKnob(null);
    setResizing(false);
    setOpen(false);
  };
  useEffect(() => () => {
    if (nudgeTimerRef.current != null) {
      window.clearInterval(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
  }, []);

  // Hidden state: only render a small pull-tab so the panel is off the way.
  // NOTE: all hooks MUST be declared above this early return.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-0 z-10 flex items-center gap-1 rounded-l-md border border-r-0 border-white/15 bg-black/70 px-2 py-3 text-[10px] uppercase tracking-widest text-white/70 hover:bg-black/90"
        aria-label="Show trackpad"
      >
        <span>‹</span>
        <span className="[writing-mode:vertical-rl] rotate-180">Pad</span>
      </button>
    );
  }



  const NudgeBtn = ({ label, dx, dy, ariaLabel }: { label: string; dx: number; dy: number; ariaLabel: string }) => (
    <button
      onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); startNudge(dx, dy); }}
      onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); stopNudge(); }}
      onPointerLeave={stopNudge}
      onPointerCancel={stopNudge}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="rounded bg-white/10 px-2 py-1 text-xs leading-4 hover:bg-white/20 active:bg-white/25"
    >
      {label}
    </button>
  );

  return (
    <div
      ref={panelRef}
      className={`${pos ? "fixed" : "absolute bottom-4 right-4"} z-20 flex select-none flex-col items-center gap-2 rounded-xl border border-white/10 bg-black/70 p-3 backdrop-blur-md`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div
        className="flex w-full cursor-grab items-center justify-between gap-3 active:cursor-grabbing"
        onPointerDown={onPanelDragStart}
        onPointerMove={onPanelDragMove}
        onPointerUp={onPanelDragEnd}
        onPointerCancel={onPanelDragEnd}
        title="Drag to move"
      >
        <span className="text-[10px] uppercase tracking-widest text-white/50">⋮⋮ Trackpad</span>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
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
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              hideTrackpad();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              hideTrackpad();
            }}
            className="rounded bg-white/10 px-1.5 text-xs leading-4 hover:bg-white/20"
            aria-label="Hide trackpad"
            title="Hide"
          >✕</button>
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
      {/* Click row — glyphs so it doesn't read as "direction" next to the knob */}
      <div className="flex gap-2">
        <button onPointerDown={(e) => { e.preventDefault(); onClick(0); }} title="Left click" aria-label="Left click" className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">◧</button>
        <button onPointerDown={(e) => { e.preventDefault(); onDoubleClick(); }} title="Double click (open)" aria-label="Double click" className="rounded bg-[#4F7CFF]/80 px-3 py-1 text-xs text-white hover:bg-[#4F7CFF]">◉</button>
        <button onPointerDown={(e) => { e.preventDefault(); onClick(2); }} title="Right click" aria-label="Right click" className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">◨</button>
      </div>
      {/* Directional pad — nudges the mouse cursor on the remote (hold to glide) */}
      <div className="grid grid-cols-3 gap-1 pt-1">
        <span />
        <NudgeBtn label="▲" dx={0} dy={-12} ariaLabel="Nudge cursor up" />
        <span />
        <NudgeBtn label="◀" dx={-12} dy={0} ariaLabel="Nudge cursor left" />
        <span />
        <NudgeBtn label="▶" dx={12} dy={0} ariaLabel="Nudge cursor right" />
        <span />
        <NudgeBtn label="▼" dx={0} dy={12} ariaLabel="Nudge cursor down" />
        <span />
      </div>
    </div>
  );
}


function OnScreenKeyboard({ onKey, onCombo }: { onKey: (vk: number) => void; onCombo: (vks: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const VK = { BACK: 8, TAB: 9, ENTER: 13, CTRL: 17, ESC: 27, SPACE: 32, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, DEL: 46, A: 65, C: 67, V: 86, X: 88, Z: 90, HOME: 36, END: 35 };

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
          <Key label="Space" vk={VK.SPACE} wide />
          <Key label="Home" vk={VK.HOME} />
          <Key label="End" vk={VK.END} />
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

function DevicesTable({ devices, presenceOf, selected, toggleSelect, onBulkEnd, onBulkRestart, onClearSelected, onConnect, canConnect }: {
  devices: Device[]; presenceOf: (d: Device) => "online" | "reconnecting" | "offline";
  selected: Set<string>; toggleSelect: (id: string) => void;
  onBulkEnd: () => void; onBulkRestart: () => void; onClearSelected: () => void;
  onConnect: (d: Device) => void; canConnect: boolean;
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
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-white/40">No devices enrolled yet.</td></tr>}
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
                  <td className="px-4 py-2 text-right">
                    {canConnect && (
                      <button
                        onClick={() => onConnect(d)}
                        disabled={p === "offline"}
                        className="rounded bg-[#4F7CFF] px-3 py-1 text-xs font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Connect
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function SessionsTable({ sessions, devices, onLive, onToggleControl, onReconnect, onEnd, onDelete, presenceOf }: {
  sessions: Session[]; devices: Device[];
  onLive: (s: Session) => void;
  onToggleControl: (s: Session) => void;
  onReconnect: (s: Session) => void;
  onEnd: (s: Session) => void;
  onDelete: (s: Session) => void;
  presenceOf: (d: Device) => "online" | "reconnecting" | "offline";
}) {
  return (
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
          {sessions.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-white/40">No sessions yet.</td></tr>}
          {sessions.map((s) => {
            const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
            const presence = dev ? presenceOf(dev) : null;
            return (
              <tr key={s.id} className="border-t border-white/5">
                <td className="px-4 py-2">
                  <div>{dev?.display_name ?? <span className="text-white/40">waiting…</span>}</div>
                  {presence && presence !== "online" && <div className="text-[10px] uppercase tracking-wider text-amber-300">{presence}</div>}
                </td>
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
                  {s.state === "invited" && (
                    <span className="text-xs text-white/40">awaiting consent…</span>
                  )}
                  {(s.state === "active" || s.state === "paused") && (
                    <>
                      <button onClick={() => onLive(s)} className="rounded bg-[#4F7CFF] px-2 py-1 text-xs font-medium hover:opacity-90">Live</button>
                      {presence !== "online" && (
                        <button onClick={() => onReconnect(s)} className="rounded bg-amber-500/80 px-2 py-1 text-xs font-medium text-white hover:bg-amber-500">Reconnect</button>
                      )}
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
  const broadcast = useServerFn(broadcastNotification);
  const sendDirect = useServerFn(sendNotification);

  const [allRows, setAllRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", password: "", display_name: "", role: "admin" as AppRole });
  const [busy, setBusy] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 50;

  // Broadcast panel
  const [bcTitle, setBcTitle] = useState("");
  const [bcBody, setBcBody] = useState("");
  const [bcSeverity, setBcSeverity] = useState<NotificationSeverity>("info");
  const [bcSending, setBcSending] = useState<null | "sending" | "sent" | "error">(null);

  // Direct notification
  const [dmTarget, setDmTarget] = useState<AdminRow | null>(null);

  async function refresh() {
    setLoading(true);
    try { setAllRows(await list()); setErr(null); setSelected(new Set()); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allRows;
    return allRows.filter((r) =>
      (r.email ?? "").toLowerCase().includes(needle) ||
      (r.display_name ?? "").toLowerCase().includes(needle) ||
      (r.role ?? "").toLowerCase().includes(needle),
    );
  }, [allRows, q]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  useEffect(() => { if (page >= pageCount) setPage(0); }, [pageCount, page]);

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

  const isProtected = (r: AdminRow) => r.user_id === meId || (r.email ?? "").startsWith("tech-197200@");

  async function remove(r: AdminRow) {
    if (isProtected(r)) return;
    if (!confirm(`Remove ${r.email ?? "this admin"}? This cannot be undone.`)) return;
    try { await removeAdmin({ data: { user_id: r.user_id } }); await refresh(); }
    catch (e) { alert((e as Error).message); }
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = pageRows.every((r) => next.has(r.user_id) || isProtected(r));
      if (allSelected) pageRows.forEach((r) => next.delete(r.user_id));
      else pageRows.forEach((r) => { if (!isProtected(r)) next.add(r.user_id); });
      return next;
    });
  }

  async function bulkRemove() {
    const targets = allRows.filter((r) => selected.has(r.user_id) && !isProtected(r));
    if (targets.length === 0) return;
    if (!confirm(`Remove ${targets.length} admin${targets.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    for (const t of targets) {
      try { await removeAdmin({ data: { user_id: t.user_id } }); } catch (e) { console.error(e); }
    }
    await refresh();
  }

  async function sendBroadcast(e: React.FormEvent) {
    e.preventDefault();
    if (!bcTitle.trim()) return;
    setBcSending("sending");
    try {
      await broadcast({ data: { title: bcTitle, body: bcBody, severity: bcSeverity } });
      setBcTitle(""); setBcBody(""); setBcSeverity("info");
      setBcSending("sent");
      setTimeout(() => setBcSending(null), 2500);
    } catch (e) {
      console.error(e);
      setBcSending("error");
      setTimeout(() => setBcSending(null), 3000);
    }
  }

  async function sendDm(title: string, body: string, severity: NotificationSeverity) {
    if (!dmTarget) return;
    try {
      await sendDirect({ data: { recipient_id: dmTarget.user_id, title, body, severity } });
      setDmTarget(null);
    } catch (e) { alert((e as Error).message); }
  }

  return (
    <div className="space-y-6">
      {/* Add admin */}
      <div className="rounded-xl border border-white/10 bg-[#0F172A] p-5">
        <h2 className="mb-1 text-sm font-semibold">Add team member</h2>
        <p className="mb-4 text-xs text-white/50">Create a new admin account with a role. Passwords must be at least 8 characters. The panel supports 20,000+ team members.</p>
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

      {/* Broadcast */}
      <div className="rounded-xl border border-white/10 bg-[#0F172A] p-5">
        <h2 className="mb-1 text-sm font-semibold">Push notification to all admins</h2>
        <p className="mb-4 text-xs text-white/50">Sends to every admin&apos;s in-app bell instantly. Recipients with the browser Notification API enabled also get an OS-level toast when their tab is in the background.</p>
        <form onSubmit={sendBroadcast} className="grid grid-cols-1 gap-3 md:grid-cols-6">
          <input required placeholder="Title" value={bcTitle} onChange={(e) => setBcTitle(e.target.value)} maxLength={200} className="md:col-span-2 rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]" />
          <input placeholder="Body (optional)" value={bcBody} onChange={(e) => setBcBody(e.target.value)} maxLength={2000} className="md:col-span-2 rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]" />
          <select value={bcSeverity} onChange={(e) => setBcSeverity(e.target.value as NotificationSeverity)} className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm">
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <button disabled={bcSending === "sending"} className="rounded bg-[#4F7CFF] px-4 py-2 text-sm font-medium disabled:opacity-50">
            {bcSending === "sending" ? "Sending…" : bcSending === "sent" ? "Sent ✓" : bcSending === "error" ? "Failed" : "Broadcast"}
          </button>
        </form>
      </div>

      {/* Team list */}
      <div className="rounded-xl border border-white/10 bg-[#0F172A]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Team members</h2>
            <span className="text-xs text-white/40">{filtered.length.toLocaleString()} total</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              placeholder="Search name, email, role…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(0); }}
              className="w-64 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-[#4F7CFF]"
            />
            {selected.size > 0 && (
              <button onClick={bulkRemove} className="rounded bg-red-500/80 px-2 py-1 text-xs">Remove {selected.size}</button>
            )}
            <button onClick={refresh} className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5">Refresh</button>
          </div>
        </div>
        {loading ? (
          <div className="p-5 text-sm text-white/50">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-5 text-sm text-white/50">No team members match.</div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40">
                <tr>
                  <th className="px-4 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={pageRows.length > 0 && pageRows.every((r) => selected.has(r.user_id) || isProtected(r))}
                      onChange={toggleAllVisible}
                    />
                  </th>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Email</th>
                  <th className="px-4 py-2 text-left">Role</th>
                  <th className="px-4 py-2 text-left">Created</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.user_id} className="border-t border-white/5">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        disabled={isProtected(r)}
                        checked={selected.has(r.user_id)}
                        onChange={() => toggleRow(r.user_id)}
                      />
                    </td>
                    <td className="px-4 py-3">{r.display_name ?? "—"}</td>
                    <td className="px-4 py-3 text-white/70">{r.email ?? "—"}</td>
                    <td className="px-4 py-3">
                      <select
                        value={r.role ?? ""}
                        disabled={isProtected(r)}
                        onChange={(e) => changeRole(r.user_id, e.target.value as AppRole)}
                        className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs disabled:opacity-50"
                      >
                        <option value="" disabled>— none —</option>
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs text-white/50">{r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-3 text-right space-x-2">
                      <button
                        onClick={() => setDmTarget(r)}
                        className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5"
                      >
                        Notify
                      </button>
                      <button
                        onClick={() => remove(r)}
                        disabled={isProtected(r)}
                        title={isProtected(r) ? "Protected account" : "Remove"}
                        className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-red-500/20 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-t border-white/5 px-4 py-3 text-xs text-white/50">
              <span>Page {page + 1} of {pageCount}</span>
              <div className="flex gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Prev</button>
                <button disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Next</button>
              </div>
            </div>
          </>
        )}
      </div>

      {dmTarget && <DirectNotifyModal target={dmTarget} onClose={() => setDmTarget(null)} onSend={sendDm} />}
    </div>
  );
}

function DirectNotifyModal({
  target,
  onClose,
  onSend,
}: {
  target: AdminRow;
  onClose: () => void;
  onSend: (title: string, body: string, severity: NotificationSeverity) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<NotificationSeverity>("info");
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#0F172A] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-xs uppercase tracking-widest text-white/50">Notify admin</div>
        <div className="mb-4 text-sm text-white">{target.display_name ?? target.email}</div>
        <div className="space-y-3">
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]" />
          <textarea placeholder="Body (optional)" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={4} className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]" />
          <select value={severity} onChange={(e) => setSeverity(e.target.value as NotificationSeverity)} className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm">
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">Cancel</button>
            <button
              disabled={busy || !title.trim()}
              onClick={async () => { setBusy(true); await onSend(title, body, severity); setBusy(false); }}
              className="rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
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



