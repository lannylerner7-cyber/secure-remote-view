import type { Device, Session } from "@/lib/console-types";

export function SessionsTable({
  sessions,
  devices,
  onLive,
  onToggleControl,
  onReconnect,
  onEnd,
  onDelete,
  presenceOf,
}: {
  sessions: Session[];
  devices: Device[];
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
          {sessions.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-white/40">
                No sessions yet.
              </td>
            </tr>
          )}
          {sessions.map((s) => {
            const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
            const presence = dev ? presenceOf(dev) : null;
            return (
              <tr key={s.id} className="border-t border-white/5">
                <td className="px-4 py-2">
                  <div>{dev?.display_name ?? <span className="text-white/40">waiting…</span>}</div>
                  {presence && presence !== "online" && (
                    <div className="text-[10px] uppercase tracking-wider text-amber-300">
                      {presence}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-white/70">{s.mode}</td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                      s.state === "active"
                        ? "bg-[#4F7CFF]/20 text-[#B9CCFF]"
                        : s.state === "paused"
                          ? "bg-amber-500/15 text-amber-300"
                          : s.state === "invited"
                            ? "bg-white/10 text-white/70"
                            : "bg-white/5 text-white/40"
                    }`}
                  >
                    {s.state === "active" && (
                      <span className="h-1.5 w-1.5 rounded-full bg-[#4F7CFF] animate-pulse" />
                    )}
                    {s.state}
                  </span>
                </td>
                <td className="px-4 py-2 text-white/60">
                  {new Date(s.created_at).toLocaleTimeString()}
                </td>
                <td className="px-4 py-2 text-right space-x-1">
                  {s.state === "invited" && (
                    <span className="text-xs text-white/40">waiting for agent…</span>
                  )}
                  {(s.state === "active" || s.state === "paused") && (
                    <>
                      <button
                        onClick={() => onLive(s)}
                        className="rounded bg-[#4F7CFF] px-2 py-1 text-xs font-medium hover:opacity-90"
                      >
                        Live
                      </button>
                      {presence !== "online" && (
                        <button
                          onClick={() => onReconnect(s)}
                          className="rounded bg-amber-500/80 px-2 py-1 text-xs font-medium text-white hover:bg-amber-500"
                        >
                          Reconnect
                        </button>
                      )}
                      <button
                        onClick={() => onToggleControl(s)}
                        className="rounded bg-white/10 px-2 py-1 text-xs"
                      >
                        {s.mode === "control" ? "Resume" : "Pause"}
                      </button>
                      <button
                        onClick={() => onEnd(s)}
                        className="rounded bg-red-500/70 px-2 py-1 text-xs"
                      >
                        End
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => onDelete(s)}
                    className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-red-500/20"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
