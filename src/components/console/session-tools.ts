import type { InputPauseState } from "@/lib/browser-input-pause";

export const SESSION_TOOLS = [
  { id: "screen", label: "Screen" },
  { id: "control", label: "Control" },
  { id: "files", label: "Files" },
  { id: "clipboard", label: "Clipboard" },
  { id: "recording", label: "Recording" },
  { id: "health", label: "Connection health" },
  { id: "signin", label: "Windows sign-in" },
  { id: "details", label: "Session details" },
] as const;

export type SessionToolId = (typeof SESSION_TOOLS)[number]["id"];

export type InputIndicatorTone = "neutral" | "ok" | "pending" | "paused" | "warn" | "secure";

/** Persistent wording for the remote-input state. A local button state is
 * never presented as an Agent confirmation. */
export function inputIndicator(options: {
  pause: InputPauseState;
  sessionMode: string | null | undefined;
  controlReady: boolean;
  secureSignIn: boolean;
  viewerPaused: boolean;
}): { label: string; tone: InputIndicatorTone; detail: string } {
  const { pause, sessionMode, controlReady, secureSignIn, viewerPaused } = options;
  if (secureSignIn) return { label: "Windows sign-in input", tone: "secure",
    detail: "Ordinary control is closed. Input goes only to the secure Windows sign-in screen." };
  if (sessionMode !== "control") return { label: "View-only", tone: "neutral",
    detail: viewerPaused ? "View-only. Local playback is paused here; sharing continues." : "View-only. No remote input is sent." };
  switch (pause.phase) {
    case "pausing": return { label: "Pausing control", tone: "pending",
      detail: "Input stopped here. Waiting for the Agent to confirm its block." };
    case "paused": return { label: "Control paused", tone: "paused",
      detail: "Agent confirmed remote input is blocked. Live video continues." };
    case "resuming": return { label: "Resuming control", tone: "pending",
      detail: "Input stays blocked until the Agent confirms." };
    case "unknown": return { label: "Input unconfirmed", tone: "warn",
      detail: pause.reason ?? "Agent input state is not confirmed. Input is blocked here." };
    case "unsupported": return { label: controlReady ? "Control active" : "Control not ready", tone: controlReady ? "ok" : "warn",
      detail: "This Agent does not support confirmed input pause." };
    case "active": return { label: controlReady ? "Control active" : "Control not ready", tone: controlReady ? "ok" : "warn",
      detail: controlReady ? "Agent confirmed input is accepted." : "Waiting for control and curtain confirmation." };
  }
}
