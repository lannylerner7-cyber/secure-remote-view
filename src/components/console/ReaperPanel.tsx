import type { Tables } from "@/integrations/supabase/types";

type Audit = Tables<"audit_logs">;
type Device = Tables<"devices">;

/**
 * Surfaces the invisible half of prune_session_ephemera(): every minute the
 * reaper writes a `session.reaped` row when a live session's device stops
 * heartbeating for 10+ minutes. Without this panel the only way to see it is
 * psql. We render the last 10 with the device name resolved so an operator
 * can tell "which machine dropped" at a glance.
 */
export function ReaperPanel({
  audit,
  devices,
}: {
  audit: Audit[];
  devices: Device[];
}) {
  const reaped = audit.filter((a) => a.event === "session.reaped").slice(0, 10);
  const deviceName = (id: string | null) =>
    id ? devices.find((d) => d.id === id)?.display_name ?? id.slice(0, 8) : "—";

  return (
    <div className="rounded-lg border border-[#F5A524]/30 bg-[#1F2A44] p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white">Session reaper</h3>
        <span className="text-xs text-white/40">
          Auto-ends live sessions whose device went silent &gt; 10 min
        </span>
      </div>
      {reaped.length === 0 ? (
        <p className="text-xs text-white/40">No sessions reaped recently.</p>
      ) : (
        <ul className="space-y-1 text-xs font-mono">
          {reaped.map((a) => {
            const detail = (a.detail ?? {}) as Record<string, unknown>;
            return (
              <li
                key={a.id}
                className="flex items-center justify-between border-b border-white/5 py-1 last:border-0"
              >
                <span className="text-white/60">
                  {new Date(a.created_at).toLocaleString()}
                </span>
                <span className="text-white/80">{deviceName(a.device_id)}</span>
                <span className="text-[#F5A524]">
                  {String(detail.reason ?? "unknown")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
