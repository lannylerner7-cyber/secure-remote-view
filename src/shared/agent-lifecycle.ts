/** Wire contract shared by the console and the authenticated device gateway. */
export type AgentRuntime = {
  device_id: string;
  agent_instance: string | null;
  agent_sequence: number;
  agent_seen_at: string | null;
  heartbeat_seconds: number;
  agent_state: "unknown" | "running" | "stopped" | "starting" | "failed" | "disabled" | "uninstalling";
  watch_instance: string | null;
  watch_sequence: number;
  watch_seen_at: string | null;
  authorization_id: string | null;
  startup_enabled: boolean;
  detail_code: string | null;
  retired_agents: string[];
  retired_watchers: string[];
};
export type RelaunchCommand = {
  id: string;
  device_id: string;
  authorization_id: string;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  state: "queued" | "received" | "starting" | "healthy" | "already_running" | "failed" | "rejected" | "expired";
  watch_instance: string | null;
  detail_code: string | null;
  updated_at: string;
};
export type DevicePresence = "online" | "reconnecting" | "offline" | "stopped";

export const LEGACY_STALE_MS = 75_000; // The existing SSE-idle Agent can legitimately wait 60s.
export const LEGACY_OFFLINE_MS = 150_000;
export const WATCH_STALE_MS = 90_000;

function age(now: number, timestamp: string | null) {
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Infinity;
}
export function watchReachable(runtime: AgentRuntime | undefined, now: number) {
  return !!runtime?.startup_enabled && age(now, runtime.watch_seen_at) < WATCH_STALE_MS;
}
export function deviceRuntime(device: { metadata?: unknown }, runtime?: AgentRuntime) {
  const metadata = device.metadata;
  // A signed rollback can restore a pre-lifecycle Agent. Do not let a retained
  // new-process row hide that client's fresh legacy heartbeat indefinitely.
  if (metadata && typeof metadata === "object" &&
      "agent_runtime_protocol" in metadata && metadata.agent_runtime_protocol === 0) return undefined;
  return runtime;
}
export function devicePresence(
  device: { status: string; last_seen_at: string | null; metadata?: unknown },
  now: number,
  runtime?: AgentRuntime,
): DevicePresence {
  runtime = deviceRuntime(device, runtime);
  if (runtime) {
    if (["disabled", "uninstalling"].includes(runtime.agent_state)) return "stopped";
    if (runtime.agent_state !== "running")
      return watchReachable(runtime, now) ? "stopped" : "offline";
    const seconds = Math.max(5, Math.min(60, runtime.heartbeat_seconds || 60));
    const elapsed = age(now, runtime.agent_seen_at);
    if (elapsed < seconds * 1000 + 15_000) return "online";
    return elapsed < Math.max(45_000, seconds * 2500) ? "reconnecting" : "offline";
  }
  if (device.status === "stopped") return "stopped"; // Historical report, not an uninstall inference.
  const elapsed = age(now, device.last_seen_at);
  if (device.status === "online" && elapsed < LEGACY_STALE_MS) return "online";
  return elapsed < LEGACY_OFFLINE_MS ? "reconnecting" : "offline";
}
export function runtimeDescription(runtime: AgentRuntime | undefined, now: number) {
  if (!runtime) return "Legacy presence · Watch status unavailable";
  const states: Record<AgentRuntime["agent_state"], string> = {
    unknown: "Agent not yet observed", running: "Agent reporting", stopped: "Agent stopped",
    starting: "Agent starting · awaiting health", failed: "Recovery failed",
    disabled: "Access disabled locally", uninstalling: "Removal reported · completion unverified",
  };
  return `${states[runtime.agent_state]} · ${watchReachable(runtime, now) ? "Watch reachable" : "Watch unavailable"}${runtime.detail_code ? ` · ${runtime.detail_code.replaceAll("_", " ")}` : ""}`;
}
