export type CurtainState = {
  supported: boolean;
  active: boolean | null;
  pending: boolean;
  reason: string | null;
};

const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_windows: "Windows 10 version 2004 or later is required.",
  local_stop: "Remote access was stopped locally. It cannot be resumed by this request.",
  authorization_changed: "The Agent's current control authorization changed.",
  ui_unavailable: "The Agent's Windows display thread is unavailable.",
  activation_busy: "A previous curtain activation is still pending.",
  activation_cancelled: "The curtain activation was cancelled.",
  lease_expired: "The curtain safety lease expired.",
  lease_unavailable: "The Agent could not renew its curtain safety lease.",
  stale_request: "This curtain request was already used or is no longer current.",
  composition_unavailable: "Windows desktop composition is unavailable.",
  capture_exclusion_failed: "Windows rejected hiding the curtain from capture. Update and rebuild the Windows Agent; control remains off.",
  capture_exclusion_unverified: "Windows did not confirm that the curtain is excluded from capture. Control remains off.",
  capture_exclusion_unavailable: "The Agent changed to a capture path that cannot safely exclude the curtain.",
  display_unavailable: "No usable local display was available.",
  display_changed: "The local display configuration changed.",
  display_style_failed: "Windows rejected the curtain window configuration.",
  display_placement_failed: "Windows could not position the curtain on the local display.",
  display_render_timeout: "The local curtain did not render before its safety deadline.",
  display_render_failed: "The local curtain could not be rendered.",
  input_pause_unavailable: "Windows could not apply the local keyboard and mouse pause.",
  curtain_inactive: "The curtain was no longer active when the Agent confirmed it.",
};

function rejection(value: Record<string, unknown>) {
  const reason = typeof value.reason === "string" && Object.hasOwn(FAILURE_MESSAGES, value.reason)
    ? value.reason : "agent_rejected";
  const code = typeof value.native_error === "number" && Number.isInteger(value.native_error) &&
    value.native_error > 0 && value.native_error <= 65535 ? ` Windows error ${value.native_error}.` : "";
  const detail = FAILURE_MESSAGES[reason] ?? "Check its local display and authorization.";
  return { reason, message: `The Agent could not apply curtain mode. ${detail}${code}` };
}

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
      if (mode() !== "control") {
        wanted = false;
        stopRenewing();
        for (const [id, item] of pending) if (item.action !== "curtain_off") {
          clearTimeout(item.timer); pending.delete(id);
          item.reject(new Error("The Agent withdrew curtain permission."));
        }
      }
      // A late status snapshot is not permission to resume a cancelled lease.
      const confirmed = active === true && !wanted ? null : active;
      publish({ supported, ...(typeof active === "boolean" ? { active: confirmed } : {}) });
    },
    receive(value: Record<string, unknown>) {
      if (value.session_id !== session || !authorization || value.authorization_id !== authorization) return;
      if (value.kind === "curtain_state" && typeof value.active === "boolean") {
        if (value.active && !wanted) {
          publish({ active: null, reason: "unconfirmed_active" });
          return;
        }
        if (!value.active) { wanted = false; stopRenewing(); }
        publish({ active: value.active, pending: false,
          reason: typeof value.reason === "string" ? value.reason.slice(0, 64) : null });
        // A stale "applied" receipt must not resurrect a lease the Agent ended.
        if (!value.active) {
          for (const [id, item] of pending) if (item.action !== "curtain_off") {
            clearTimeout(item.timer); pending.delete(id);
            item.reject(new Error(value.reason && Object.hasOwn(FAILURE_MESSAGES, String(value.reason))
              ? rejection(value).message : "The Agent released curtain mode."));
          }
        }
        return;
      }
      if (value.kind !== "action_status" || typeof value.request_id !== "string") return;
      const item = pending.get(value.request_id);
      if (!item || item.action !== value.action || !["applied", "rejected"].includes(String(value.status))) return;
      clearTimeout(item.timer); pending.delete(value.request_id);
      const expectedActive = item.action !== "curtain_off";
      if (value.status !== "applied" || value.active !== expectedActive) {
        wanted = false; stopRenewing();
        const failure = rejection(value);
        publish({ pending: false, active: typeof value.active === "boolean" ? value.active : null, reason: failure.reason });
        item.reject(new Error(failure.message));
      } else {
        publish({ active: value.active, pending: [...pending.values()].some(p => p.action !== "curtain_renew"), reason: null });
        if (!value.active) stopRenewing();
        item.resolve();
      }
    },
    async set(enabled: boolean) {
      if (enabled && state.pending) throw new Error("A curtain request is awaiting acknowledgement.");
      stopRenewing();
      wanted = enabled;
      if (!enabled) {
        // Safety release must interrupt an in-flight activation/renewal.
        // Their late receipts cannot make the cancelled curtain appear active.
        for (const [id, item] of pending) {
          clearTimeout(item.timer);
          pending.delete(id);
          item.reject(new Error("Curtain request cancelled by release."));
        }
      }
      publish({ pending: true, reason: null });
      try {
        await request(enabled ? "curtain_on" : "curtain_off");
        if (enabled && state.active === true) renewLater();
      } catch (error) {
        publish({ pending: [...pending.values()].some(item => item.action !== "curtain_renew") });
        throw error;
      }
    },
    reset,
    dispose() { reset(); listeners.clear(); },
  };
}
