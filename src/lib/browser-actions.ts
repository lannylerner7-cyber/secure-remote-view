import { createBrowserCurtain } from "./browser-curtain";
import { createBrowserUnlock } from "./browser-unlock";
export type AgentMode = "view" | "control" | null;

/** Correlates application receipts, not just successful DataChannel.send(). */
export function createBrowserActions(
  sessionId: string,
  authorizationId: string | null,
  channel: () => RTCDataChannel | null,
  active: () => boolean,
  overloaded: () => void,
) {
  let mode: AgentMode = null;
  const listeners = new Set<(mode: AgentMode) => void>();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function reset(reason = "Input channel disconnected") {
    unlock.reset();
    curtain.reset(reason);
    mode = null;
    listeners.forEach(listener => listener(null));
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason)); }
    pending.clear();
  }
  function send(payload: unknown): boolean {
    const dc = channel();
    if (!active() || !dc || dc.readyState !== "open") return false;
    // Fail visibly rather than accumulating delayed keyboard/mouse input.
    if (dc.bufferedAmount > 64 * 1024) {
      reset("Input channel congested; reconnect the viewer.");
      overloaded();
      return false;
    }
    try {
      const text = JSON.stringify(payload);
      if (new TextEncoder().encode(text).length > 16 * 1024) return false;
      dc.send(text);
      return true;
    } catch { return false; }
  }
  const curtain = createBrowserCurtain(sessionId, authorizationId, send, () => mode);
  const unlock = createBrowserUnlock(sessionId, authorizationId, send);
  return {
    unlock,
    send,
    reset,
    onCurtain: curtain.onState,
    setCurtain: curtain.set,
    mode: () => mode,
    onMode(listener: (mode: AgentMode) => void) {
      listeners.add(listener);
      listener(mode);
      return () => { listeners.delete(listener); };
    },
    receive(raw: unknown) {
      if (!active() || typeof raw !== "string" || raw.length > 8192) return;
      try {
        const value = JSON.parse(raw);
        if (!value || value.session_id !== sessionId) return;
        unlock.receive(value);
        if (value.kind === "permission_status" &&
            authorizationId !== null && value.authorization_id === authorizationId &&
            (value.mode === "view" || value.mode === "control")) {
          mode = value.mode;
          curtain.permission(value.curtain_supported === true,
            typeof value.curtain_active === "boolean" ? value.curtain_active : undefined);
          listeners.forEach(listener => listener(mode));
        }
        curtain.receive(value);
        if (value.kind !== "action_status" || value.action !== "switch_monitor" ||
            typeof value.request_id !== "string" || !["applied", "rejected"].includes(value.status)) return;
        const item = pending.get(value.request_id);
        if (!item) return;
        pending.delete(value.request_id);
        clearTimeout(item.timer);
        if (value.status === "applied") item.resolve();
        else item.reject(new Error("Agent rejected the monitor selection. Check the display and view permission."));
      } catch { /* Unrecognized peer data is not an acknowledgement. */ }
    },
    selectMonitor(deviceName: string): Promise<void> {
      if (pending.size) return Promise.reject(new Error("A monitor selection is already awaiting acknowledgement."));
      if (!mode || !deviceName || deviceName.length > 200)
        return Promise.reject(new Error("The Agent input channel is not ready."));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Agent did not acknowledge the monitor selection. Its result is unknown."));
        }, 8000);
        pending.set(id, { resolve, reject, timer });
        if (!send({ kind: "switch_monitor", payload: { device_name: deviceName, request_id: id } })) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("Monitor selection was not sent."));
        }
      });
    },
    dispose() { unlock.dispose(); reset(); curtain.dispose(); listeners.clear(); },
  };
}
