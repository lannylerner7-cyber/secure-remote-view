import { EMPTY_UNLOCK, type UnlockState, type UnlockTicket } from "@/shared/windows-unlock";

/** No retries, HTTP keyboard fallback, or cross-peer resurrection. */
export function createBrowserUnlock(
  sessionId: string, authorizationId: string | null, send: (value: unknown) => boolean,
) {
  let current: UnlockState = { ...EMPTY_UNLOCK };
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastReceipt = 0, deadline = 0, sequence = 0, pinSent = false;
  let pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const listeners = new Set<(state: UnlockState) => void>();
  const publish = (next: UnlockState) => { current = next; listeners.forEach(cb => cb({ ...next })); };
  const active = () => ["starting", "ready", "submitted"].includes(current.phase);
  function message(kind: string, extra: Record<string, unknown> = {}) {
    return send({ kind, payload: { request_id: current.requestId, sequence: ++sequence, ...extra } });
  }
  function stop(phase: "blocked" | "cancelled", reason: string, notify = true) {
    if (timer) clearInterval(timer);
    timer = null;
    if (notify && active()) message("unlock_cancel");
    pending?.reject(new Error(reason)); pending = null;
    publish({ phase, requestId: current.requestId, reason });
  }
  return {
    state: () => ({ ...current }),
    active,
    onState(cb: (state: UnlockState) => void) {
      listeners.add(cb); cb({ ...current }); return () => { listeners.delete(cb); };
    },
    begin(ticket: UnlockTicket): Promise<void> {
      if (!authorizationId || active()) return Promise.reject(new Error("An unlock is unavailable or already pending."));
      sequence = 0; pinSent = false; lastReceipt = Date.now();
      deadline = Math.min(Date.parse(ticket.expiresAt), Date.now() + 120_000);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) return Promise.reject(new Error("The unlock request expired."));
      publish({ phase: "starting", requestId: ticket.requestId, reason: null });
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        if (!message("unlock_begin", { recording_stopped: true })) {
          stop("blocked", "The unlock command channel is unavailable.", false); return;
        }
        timer = setInterval(() => {
          if (Date.now() >= deadline || Date.now() - lastReceipt > 5000) {
            stop("blocked", "Unlock confirmation timed out. No PIN was retried."); return;
          }
          if (!message("unlock_renew")) stop("blocked", "Unlock channel disconnected.", false);
        }, 1000);
      });
    },
    input(kind: string, payload: Record<string, unknown>): boolean {
      if (current.phase !== "ready" || pinSent) return false;
      const sent = message("unlock_input", { input: { kind, payload } });
      if (!sent) stop("blocked", "Secure input delivery failed. No retry.", false);
      return sent;
    },
    sas: () => current.phase === "ready" && message("unlock_sas"),
    useSavedPin() {
      if (current.phase !== "ready" || pinSent) throw new Error("The PIN cannot be submitted again in this attempt.");
      pinSent = true;
      if (!message("unlock_pin", { pin_field_confirmed: true })) {
        stop("blocked", "PIN submission could not be confirmed. It will not be retried.", false);
        throw new Error("PIN submission could not be confirmed.");
      }
      publish({ ...current, phase: "submitted", reason: "Waiting for Windows to confirm unlock. No automatic retry." });
    },
    receive(value: Record<string, unknown>) {
      if (value.kind !== "unlock_status" || !active() || value.session_id !== sessionId ||
          value.authorization_id !== authorizationId || value.request_id !== current.requestId ||
          !["starting", "ready", "submitted", "unlocked", "cancelled", "blocked"].includes(String(value.phase))) return;
      lastReceipt = Date.now();
      const phase = value.phase as UnlockState["phase"];
      // A late ready receipt cannot make a consumed PIN retryable.
      if ((phase === "ready" || phase === "starting") && pinSent) return;
      const reason = typeof value.reason === "string" && /^[a-z_]{1,80}$/.test(value.reason)
        ? value.reason.replaceAll("_", " ") : null;
      publish({ phase, requestId: current.requestId, reason });
      if (phase === "ready") { pending?.resolve(); pending = null; }
      if (phase === "unlocked" || phase === "cancelled" || phase === "blocked") {
        if (timer) clearInterval(timer);
        timer = null;
        pending?.reject(new Error(reason ?? "Unlock ended before the sign-in screen was ready.")); pending = null;
      }
    },
    cancel() { if (active()) stop("cancelled", "Unlock cancelled."); },
    reset() { if (active()) stop("blocked", "Unlock channel closed. Start a new attempt explicitly.", false); },
    dispose() { if (active()) stop("cancelled", "Viewer closed."); listeners.clear(); },
  };
}
