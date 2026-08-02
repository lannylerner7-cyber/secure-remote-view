import type { Device } from "@/lib/console-types";
import { PowerMenu } from "./PowerMenu";

export function DevicesTable({
  devices,
  presenceOf,
  selected,
  toggleSelect,
  onBulkEnd,
  onBulkRestart,
  onClearSelected,
  onConnect,
  canConnect,
  canDelete,
  onDelete,
  canPower,
  canShutdown,
  onWake,
  onPower,
}: {
  devices: Device[];
  presenceOf: (d: Device) => "online" | "reconnecting" | "offline";
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  onBulkEnd: () => void;
  onBulkRestart: () => void;
  onClearSelected: () => void;
  onConnect: (d: Device) => void;
  canConnect: boolean;
  canDelete: boolean;
  onDelete: (d: Device) => void;
  canPower: boolean;
  canShutdown: boolean;
  onWake: (d: Device) => void;
  onPower: (d: Device, kind: "reboot" | "shutdown" | "lock" | "logoff") => void;
}) {
  return (
    <div>
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="text-white/60">{selected.size} selected</span>
          <button onClick={onBulkEnd} className="rounded bg-red-500/80 px-2 py-1">
            End sessions
          </button>
          <button onClick={onBulkRestart} className="rounded bg-white/10 px-2 py-1">
            Restart agent
          </button>
          <button onClick={onClearSelected} className="rounded border border-white/15 px-2 py-1">
            Clear
          </button>
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
            {devices.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-white/40">
                  No devices enrolled yet.
                </td>
              </tr>
            )}
            {devices.map((d) => {
              const p = presenceOf(d);
              return (
                <tr key={d.id} className="border-t border-white/5">
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      onChange={() => toggleSelect(d.id)}
                    />
                  </td>
                  <td className="px-4 py-2 font-medium">{d.display_name}</td>
                  <td className="px-4 py-2 text-white/60">{d.hostname ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                        p === "online"
                          ? "bg-green-500/15 text-green-300"
                          : p === "reconnecting"
                            ? "bg-amber-500/15 text-amber-300"
                            : "bg-white/10 text-white/50"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${p === "online" ? "bg-green-400" : p === "reconnecting" ? "bg-amber-400 animate-pulse" : "bg-white/40"}`}
                      />
                      {p}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-white/60">
                    {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      {canConnect && (
                        <button
                          onClick={() => onConnect(d)}
                          disabled={p === "offline"}
                          className="rounded bg-[#4F7CFF] px-3 py-1 text-xs font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Connect
                        </button>
                      )}
                      {canPower && p !== "online" && (
                        <button
                          onClick={() => onWake(d)}
                          className="rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-200 hover:bg-amber-400/20"
                          title="Wake this machine via a peer on the same LAN (magic packet)"
                        >
                          Wake
                        </button>
                      )}
                      {canPower && p === "online" && (
                        <PowerMenu onSelect={(k) => onPower(d, k)} canShutdown={canShutdown} />
                      )}
                      {canDelete && (
                        <button
                          onClick={() => onDelete(d)}
                          className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-500/20"
                          title="Remove device"
                        >
                          Delete
                        </button>
                      )}
                    </div>
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
