import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

type Device = Tables<"devices">;
type Session = Tables<"sessions">;

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
  head: () => ({ meta: [{ title: "Admin — ConnectLive" }] }),
});

function AdminPage() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<Tables<"audit_logs">[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [liveId, setLiveId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? ""));

    void refresh();

    const ch = supabase
      .channel("admin-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "audit_logs" }, refresh)
      .subscribe();

    const t = setInterval(refresh, 5000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(t);
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

  async function invite(device: Device, mode: "view" | "control") {
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("sessions").insert({
      device_id: device.id,
      technician_id: u.user?.id,
      mode,
      state: "invited",
    });
    if (error) alert(error.message);
  }

  async function endSession(s: Session) {
    await supabase.from("sessions").update({ state: "ended", ended_at: new Date().toISOString() }).eq("id", s.id);
  }

  async function pauseSession(s: Session) {
    await supabase.from("sessions").update({ state: s.state === "paused" ? "active" : "paused" }).eq("id", s.id);
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen bg-[#0F172A] text-white">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="inline-block h-3 w-3 rounded-full bg-[#4F7CFF]" />
            <span className="font-semibold">ConnectLive · Admin</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-white/60">
            <span>{userEmail}</span>
            <button onClick={signOut} className="rounded border border-white/15 px-2 py-1 hover:bg-white/5">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">
            Devices ({devices.length})
          </h2>
          <div className="overflow-hidden rounded-lg border border-white/10 bg-[#1F2A44]">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-left text-xs uppercase text-white/50">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Host</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Last seen</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-white/40">
                      No devices enrolled yet. Run the ConnectLive agent on a Windows machine.
                    </td>
                  </tr>
                )}
                {devices.map((d) => (
                  <tr key={d.id} className="border-t border-white/5">
                    <td className="px-4 py-2 font-medium">{d.display_name}</td>
                    <td className="px-4 py-2 text-white/60">{d.hostname ?? "—"}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                          d.status === "online" ? "bg-green-500/15 text-green-300" : "bg-white/10 text-white/50"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${d.status === "online" ? "bg-green-400" : "bg-white/40"}`} />
                        {d.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-white/60">
                      {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => invite(d, "view")}
                        className="mr-2 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/15"
                      >
                        Request view
                      </button>
                      <button
                        onClick={() => invite(d, "control")}
                        className="rounded bg-[#4F7CFF] px-2 py-1 text-xs font-medium hover:opacity-90"
                      >
                        Request control
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">
            Sessions
          </h2>
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
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-white/40">
                      No sessions yet.
                    </td>
                  </tr>
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
                            <button onClick={() => setLiveId(s.id)} className="mr-2 rounded bg-[#4F7CFF] px-2 py-1 text-xs font-medium hover:opacity-90">
                              Live view
                            </button>
                            <button onClick={() => pauseSession(s)} className="mr-2 rounded bg-white/10 px-2 py-1 text-xs">
                              {s.state === "paused" ? "Resume" : "Pause"}
                            </button>
                            <button onClick={() => endSession(s)} className="rounded bg-red-500/80 px-2 py-1 text-xs">
                              End
                            </button>
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
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">
            Audit
          </h2>
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

      {liveId && (() => {
        const s = sessions.find((x) => x.id === liveId);
        if (!s) return null;
        const dev = devices.find((d) => d.id === s.device_id);
        const active = s.state === "active";
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setLiveId(null)}>
            <div className="w-full max-w-4xl overflow-hidden rounded-xl border border-white/10 bg-[#0F172A] shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[#4F7CFF] animate-pulse" : "bg-amber-400"}`} />
                  <div>
                    <div className="text-sm font-semibold">{dev?.display_name ?? "Device"}</div>
                    <div className="text-xs text-white/50">{s.mode === "control" ? "Remote control" : "View only"} · {s.state}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => pauseSession(s)} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15">
                    {s.state === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button onClick={() => { endSession(s); setLiveId(null); }} className="rounded bg-red-500/80 px-3 py-1.5 text-xs">
                    End session
                  </button>
                  <button onClick={() => setLiveId(null)} className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5">
                    Close
                  </button>
                </div>
              </div>
              <div className="relative aspect-video bg-gradient-to-br from-[#1F2A44] to-[#0F172A]">
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                  <div className="flex items-center gap-2 rounded-full border border-[#4F7CFF]/30 bg-[#4F7CFF]/10 px-3 py-1 text-xs text-[#B9CCFF]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#4F7CFF] animate-pulse" />
                    {active ? "Live signaling channel open" : "Session paused"}
                  </div>
                  <div className="text-sm text-white/70">Waiting for agent media stream…</div>
                  <div className="text-xs text-white/40 max-w-md">
                    The remote user sees a persistent on-screen banner and consented to this {s.mode} session.
                    Screen frames stream in over the WebRTC channel once the agent negotiates codecs.
                  </div>
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
