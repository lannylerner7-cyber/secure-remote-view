import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

type Telemetry = Tables<"session_telemetry">;

/**
 * S11 — render telemetry. The native console writes one row per minute per
 * live session (fps, latency, queue, drops, present path, input transport,
 * media wire path, ICE restarts). This panel is the only place that reading
 * is visible without opening admin.log on the technician's machine.
 */
export function RenderHealthPanel({ sessionId }: { sessionId?: string | null }) {
  const [rows, setRows] = useState<Telemetry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let q = supabase
        .from("session_telemetry")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10);
      if (sessionId) q = q.eq("session_id", sessionId);
      const { data } = await q;
      if (!cancelled && data) setRows(data);
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId]);

  const num = (v: number | null, suffix = "") =>
    v === null || v === undefined ? "—" : `${v}${suffix}`;

  return (
    <div className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white">Render health</h3>
        <span className="text-xs text-white/40">
          One sample per minute from each live console
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-white/40">
          No render telemetry yet — it appears a minute into a native live session.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead className="text-white/40">
              <tr className="text-left">
                <th className="py-1 pr-3 font-normal">When</th>
                <th className="py-1 pr-3 font-normal">fps</th>
                <th className="py-1 pr-3 font-normal">bitrate</th>
                <th className="py-1 pr-3 font-normal">latency</th>

                <th className="py-1 pr-3 font-normal">queue</th>
                <th className="py-1 pr-3 font-normal">dropped</th>
                <th className="py-1 pr-3 font-normal">size</th>
                <th className="py-1 pr-3 font-normal">render</th>
                <th className="py-1 pr-3 font-normal">wire</th>
                <th className="py-1 pr-3 font-normal">input</th>
                <th className="py-1 pr-3 font-normal">restarts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-white/5 text-white/80">
                  <td className="py-1 pr-3 text-white/50">
                    {new Date(r.created_at).toLocaleTimeString()}
                  </td>
                  <td className="py-1 pr-3">{num(r.fps as number | null)}</td>
                  <td className="py-1 pr-3">
                    {num(r.latency_ms as number | null, " ms")}
                  </td>
                  <td className="py-1 pr-3">{num(r.queue_depth)}</td>
                  <td className="py-1 pr-3">
                    {r.frames_dropped === null ? "—" : String(r.frames_dropped)}
                  </td>
                  <td className="py-1 pr-3">
                    {r.source_width && r.source_height
                      ? `${r.source_width}x${r.source_height}`
                      : "—"}
                  </td>
                  <td className="py-1 pr-3">{r.render_path ?? "—"}</td>
                  <td className="py-1 pr-3">{r.wire_path ?? "—"}</td>
                  <td className="py-1 pr-3">{r.input_path ?? "—"}</td>
                  <td className="py-1 pr-3">{num(r.ice_restarts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
