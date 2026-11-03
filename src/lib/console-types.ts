import type { Tables } from "@/integrations/supabase/types";

export type Device = Tables<"devices">;
export type Session = Tables<"sessions">;
export type LiveFrame = {
  frame: string;
  width: number | null;
  height: number | null;
  updated_at: string;
};
export type LiveCursor = {
  x: number;
  y: number;
  frame_w: number | null;
  frame_h: number | null;
  kind: string;
  visible: boolean;
  updated_at: string;
};

export const NAV_VALUES = [
  "dashboard",
  "devices",
  "expected",
  "sessions",
  "audit",
  "settings",
  "team",
] as const;

export type Nav = (typeof NAV_VALUES)[number];

export type Presence = "online" | "reconnecting" | "offline" | "stopped";

// Compatibility constants; new Agents carry a bounded cadence in agent_runtime.
export { LEGACY_STALE_MS as STALE_MS, LEGACY_OFFLINE_MS as OFFLINE_MS } from "@/shared/agent-lifecycle";
