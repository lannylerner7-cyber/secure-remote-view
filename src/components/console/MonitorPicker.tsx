import type { Device } from "@/lib/console-types";

/**
 * SCOPE:CAPTURE — browser mirror of the native admin's monitor picker.
 *
 * The agent is the single authority for "which display are we capturing"
 * (agent/src/MonitorSelector.cs) and publishes its inventory on every
 * heartbeat into devices.metadata.monitors / .selected_monitor. So this is a
 * pure mirror: render what the agent reported, and a pick enqueues a
 * `switch_monitor` power command. We never optimistically rewrite the
 * selection — the next heartbeat confirms it.
 */
export type MonitorEntry = {
  index: number;
  device_name: string;
  label?: string | null;
  primary?: boolean;
};

export function readMonitors(device: Device | null | undefined): {
  monitors: MonitorEntry[];
  selected: string | null;
} {
  const meta = (device?.metadata ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(meta.monitors) ? (meta.monitors as unknown[]) : [];
  const monitors: MonitorEntry[] = raw
    .map((m, i) => {
      const o = (m ?? {}) as Record<string, unknown>;
      const name = typeof o.device_name === "string" ? o.device_name : null;
      if (!name) return null;
      return {
        index: typeof o.index === "number" ? o.index : i,
        device_name: name,
        label: typeof o.label === "string" ? o.label : null,
        primary: o.primary === true,
      } satisfies MonitorEntry;
    })
    .filter((m): m is MonitorEntry => m !== null);
  const selectedRaw = typeof meta.selected_monitor === "string" ? meta.selected_monitor : null;
  const selected =
    selectedRaw && monitors.some((m) => m.device_name === selectedRaw)
      ? selectedRaw
      : (monitors.find((m) => m.primary)?.device_name ?? monitors[0]?.device_name ?? null);
  return { monitors, selected };
}

export function MonitorPicker({
  device,
  disabled,
  onSelect,
}: {
  device: Device | null | undefined;
  disabled?: boolean;
  onSelect: (m: MonitorEntry) => void;
}) {
  const { monitors, selected } = readMonitors(device);
  // Only earn screen space when there's a real choice.
  if (monitors.length < 2) return null;

  return (
    <label className="flex items-center gap-1.5 text-xs text-white/60">
      <span className="sr-only">Captured display</span>
      <select
        value={selected ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const next = monitors.find((m) => m.device_name === e.target.value);
          if (next && next.device_name !== selected) onSelect(next);
        }}
        title="Switch which display the agent captures"
        className="rounded border border-white/15 bg-white/5 px-2 py-1.5 text-xs text-white disabled:opacity-40"
      >
        {monitors.map((m) => (
          <option key={m.device_name} value={m.device_name} className="bg-[#0F172A]">
            {m.label ?? `Display ${m.index + 1}`}
            {m.primary ? " (primary)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
