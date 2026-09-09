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

// Agent heartbeat cadence = 15s; backend flags reconnect after a 60s gap.
// Give one missed beat of grace before "reconnecting", and match the backend
// threshold for hard "offline".
export const STALE_MS = 30_000;
export const OFFLINE_MS = 75_000;
