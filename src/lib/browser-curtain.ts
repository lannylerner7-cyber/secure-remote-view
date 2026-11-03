export type CurtainState = {
  supported: boolean;
  active: boolean | null;
  pending: boolean;
  reason: string | null;
};

/** Application receipts + a bounded lease, never an optimistic on/off toggle. */
export function createBrowserCurtain(
  session: string, authorization: string | null,
  send: (message: unknown) => boolean, mode: () => string | null,
) {
  let state: CurtainState = { supported: false, active: null, pending: false, reason: null };
  const listeners = new Set<(value: CurtainState) => void>();
  const pending = new Map<string, {
    action: string; timer: ReturnType<typeof setTimeout>;
    resolve: () => void; reject: (error: Error) => void;
  }>();
  let renew: ReturnType<typeof setTimeout> | undefined;
  let wanted = false;
  const publish = (patch: Partial<CurtainState>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener(state));
  };
  const stopRenewing = () => { if (renew) clearTimeout(renew); renew = undefined; };
  function renewLater() {
    stopRenewing();
    if (!wanted || state.active !== true || mode() !== "control") return;
    renew = setTimeout(() => {
      renew = undefined;
      void request("curtain_renew").then(renewLater).catch(() => { /* State already shows unconfirmed. */ });
    }, 1500);
  }
  function request(action: "curtain_on" | "curtain_off" | "curtain_renew"): Promise<void> {
    if (!state.supported || (action !== "curtain_off" && mode() !== "control"))
      return Promise.reject(new Error("The Agent has not confirmed curtain support and control permission."));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        wanted = false;
        stopRenewing();
        publish({ active: null, pending: false, reason: "acknowledgement_timeout" });
        reject(new Error("Curtain status is unconfirmed. Renewals stopped; the Agent's five-second lease must expire."));
      }, 3000);
      pending.set(id, { action, timer, resolve, reject });
      if (!send({ kind: action, payload: { request_id: id } })) {
        clearTimeout(timer); pending.delete(id); stopRenewing();
        publish({ active: null, pending: false, reason: "channel_unavailable" });
        reject(new Error("Curtain request was not sent."));
      }
    });
  }
  function reset(reason = "input_channel_disconnected") {
    stopRenewing();
    wanted = false;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason)); }
    pending.clear();
    publish({ supported: false, active: null, pending: false, reason });
  }
  return {
    onState(listener: (value: CurtainState) => void) {
      listeners.add(listener); listener(state);
      return () => { listeners.delete(listener); };
    },
    permission(supported: boolean, active?: boolean) {
      publish({ supported, ...(typeof active === "boolean" ? { active } : {}) });
      if (mode() !== "control") stopRenewing();
    },
    receive(value: Record<string, unknown>) {
      if (value.session_id !== session || !authorization || value.authorization_id !== authorization) return;
      if (value.kind === "curtain_state" && typeof value.active === "boolean") {
        if (!value.active) { wanted = false; stopRenewing(); }
        publish({ active: value.active, pending: false,
          reason: typeof value.reason === "string" ? value.reason.slice(0, 64) : null });
        // A stale "applied" receipt must not resurrect a lease the Agent ended.
        if (!value.active) {
          for (const [id, item] of pending) if (item.action !== "curtain_off") {
            clearTimeout(item.timer); pending.delete(id);
            item.reject(new Error("The Agent released curtain mode."));
          }
        }
        return;
      }
      if (value.kind !== "action_status" || typeof value.request_id !== "string") return;
      const item = pending.get(value.request_id);
      if (!item || item.action !== value.action || !["applied", "rejected"].includes(String(value.status))) return;
      clearTimeout(item.timer); pending.delete(value.request_id);
      if (value.status !== "applied" || typeof value.active !== "boolean") {
        wanted = false; stopRenewing();
        publish({ pending: false, active: typeof value.active === "boolean" ? value.active : null, reason: "agent_rejected" });
        item.reject(new Error("The Agent could not apply curtain mode. Check its local display and authorization."));
      } else {
        publish({ active: value.active, pending: [...pending.values()].some(p => p.action !== "curtain_renew"), reason: null });
        if (!value.active) stopRenewing();
        item.resolve();
      }
    },
    async set(enabled: boolean) {
      if (state.pending) throw new Error("A curtain request is awaiting acknowledgement.");
      stopRenewing();
      wanted = enabled;
      publish({ pending: true, reason: null });
      try {
        await request(enabled ? "curtain_on" : "curtain_off");
        if (enabled && state.active === true) renewLater();
      } catch (error) { publish({ pending: false }); throw error; }
    },
    reset,
    dispose() { reset(); listeners.clear(); },
  };
}
