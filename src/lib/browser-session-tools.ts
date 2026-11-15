import {
  EMPTY_SESSION_TOOLS, type ToolBinding, type SessionToolsClient, type SessionToolsState,
  type RemoteDirectory, type RemoteEntry, type MicrophonePhase, type VerificationPhase,
} from "@/shared/session-tools";

export function createSessionToolsClient(
  channel: RTCDataChannel, binding: ToolBinding, current: () => boolean,
  files: { expect(id: string, signal?: AbortSignal): Promise<Blob>; cancel(id: string): void },
  prepareProtected: () => Promise<void>, audio: HTMLAudioElement,
  audioHealthy: () => Promise<boolean> = async () => true,
): SessionToolsClient {
  let state = { ...EMPTY_SESSION_TOOLS }, closed = false, sequence = 0;
  let micRequest: string | null = null, verifyRequest: string | null = null, downloadId: string | null = null;
  let lastReceipt = 0;
  let healthCheck = false;
  const listeners = new Set<(state: SessionToolsState) => void>();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const valid = () => !closed && current() && channel.readyState === "open";
  const update = (patch: Partial<SessionToolsState>) => {
    state = { ...state, ...patch }; listeners.forEach(cb => cb({ ...state }));
    audio.muted = state.microphone !== "sharing";
    if (!audio.muted) void audio.play().catch(() => {
      // Muted playback isn't Off: ask the Agent to dispose its capture source.
      void microphone(false).catch(() => {});
    });
  };
  function send(action: string, id: string, payload: Record<string, unknown> = {}) {
    if (!valid()) throw new Error("Session tools connection unavailable.");
    channel.send(JSON.stringify({ version: 1, binding, action, requestId: id, sequence: ++sequence, payload }));
  }
  function request(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal, id: string = crypto.randomUUID()) {
    if (!valid() || signal?.aborted || pending.size >= 8) return Promise.reject(new Error("Session tools unavailable or busy."));
    return new Promise<unknown>((resolve, reject) => {
      const fail = () => {
        clearTimeout(pending.get(id)?.timer); pending.delete(id);
        reject(new Error("Agent response unconfirmed. No automatic retry."));
      };
      const timer = setTimeout(fail, 8000);
      pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", fail, { once: true });
      try { send(action, id, payload); } catch { fail(); }
    });
  }
  channel.onopen = () => { void request("status").catch(() => {}); };
  channel.onmessage = event => {
    if (!valid() || typeof event.data !== "string" || event.data.length > 65536) return;
    try {
      const v = JSON.parse(event.data);
      if (v.version !== 1 || !v.binding || Object.entries(binding).some(([k,value]) => v.binding[k] !== value)) return;
      const p = pending.get(v.requestId);
      if (v.action === "status" && v.ok === true && Array.isArray(v.value?.roots) && v.value.roots.length <= 8) {
        update({ supported: true, roots: v.value.roots, microphoneAllowed: v.value.microphoneAllowed === true, setup: v.value.setup ?? null });
      }
      if (v.action === "microphone" && v.requestId === micRequest) {
        if (["off","sharing","locally_stopped","permission_denied","device_unavailable","transport_failure"].includes(v.value?.phase)) {
          lastReceipt = Date.now();
          update({ microphone: v.value.phase as MicrophonePhase, reason: v.value.reason ?? null });
          if (v.value.phase !== "sharing") micRequest = null;
        }
      }
      if (v.action === "verification" && v.requestId === verifyRequest &&
          ["approval_required","in_progress","cancelled","result_unconfirmed","unsupported"].includes(v.value?.phase)) {
        update({ verification: v.value.phase as VerificationPhase, requestId: verifyRequest, reason: v.value.reason ?? null });
        if (["cancelled","result_unconfirmed","unsupported"].includes(v.value.phase)) verifyRequest = null;
      }
      if (p) {
        clearTimeout(p.timer); pending.delete(v.requestId);
        if (v.ok === false) p.reject(new Error(
          typeof v.error === "string" && /^[a-z_]{1,80}$/.test(v.error) ? v.error.replaceAll("_"," ") : "Agent request rejected."));
        else p.resolve(v.value);
      }
    } catch { /* Malformed or foreign receipts establish no authority. */ }
  };
  channel.onclose = () => close();
  async function microphone(listen: boolean) {
    if (listen) {
      if (!state.supported || !state.microphoneAllowed || micRequest) throw new Error("Microphone consent or current support is unavailable.");
      const id = crypto.randomUUID(); micRequest = id; lastReceipt = Date.now();
      update({ microphone: "requesting" });
      try {
        // Unlock playback from the user's click, but stay muted until the
        // actual Agent receipt. Never request the administrator's microphone.
        audio.muted = true;
        void audio.play().catch(()=>{});
        await request("microphone_on", {}, undefined, id);
      }
      catch (error) {
        if (micRequest === id) {
          try { send("microphone_off", id); } catch {}
          micRequest = null; update({ microphone: "transport_failure" });
        }
        throw error;
      }
    } else {
      const id = crypto.randomUUID();
      micRequest = null; // A late On/renew receipt must not resurrect playback.
      audio.muted = true;
      try { await request("microphone_off", {}, undefined, id); if (!micRequest) update({ microphone: "off" }); }
      catch (error) { update({ microphone: "transport_failure", reason: "Off receipt unconfirmed; capture lease expires within five seconds." }); throw error; }
    }
  }
  const timer = setInterval(() => {
    if (!valid()) { if (state.microphone === "sharing" || state.microphone === "requesting") update({ microphone: "transport_failure" }); return; }
    if (micRequest) {
      if (Date.now() - lastReceipt > 5000) {
        const id = micRequest; micRequest = null;
        try { send("microphone_off", id); } catch {}
        update({ microphone: "transport_failure", reason: "Microphone authority expired. Listening will not resume automatically." });
      } else { try { send("microphone_renew", micRequest); } catch {} }
      if (!healthCheck && state.microphone === "sharing") {
        healthCheck = true;
        const checkedId = micRequest;
        void audioHealthy().then(async healthy => {
          if (!healthy && micRequest === checkedId) {
            await microphone(false).catch(() => {});
            if (!micRequest) update({microphone:"transport_failure",reason:"Audio congestion or missing packets stopped microphone capture. Video was not restarted."});
          }
        }).catch(() => { /* Missing stats is not evidence to request extra authority. */ })
          .finally(() => { healthCheck = false; });
      }
    }
    if (verifyRequest) { try { send("verification_renew", verifyRequest); } catch {} }
  }, 1000);
  function close() {
    if (closed) return;
    if (micRequest) { try { send("microphone_off", micRequest); } catch {} }
    if (verifyRequest) { try { send("verification_cancel", verifyRequest); } catch {} }
    if (downloadId) files.cancel(downloadId);
    closed = true; clearInterval(timer); audio.muted = true; audio.pause(); audio.srcObject = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Session connection changed.")); }
    pending.clear(); micRequest = verifyRequest = downloadId = null;
    update({ ...EMPTY_SESSION_TOOLS, verification: state.verification === "idle" ? "idle" : "cancelled" });
    try { channel.close(); } catch {}
  }
  return {
    state: () => ({ ...state }), onState(cb) { listeners.add(cb); cb({ ...state }); return () => { listeners.delete(cb); }; },
    async refresh() { await request("status"); },
    async list(rootId, path, cursor = null, signal) {
      const result = await request("list", { rootId, path, cursor }, signal) as RemoteDirectory;
      if (!result || result.rootId !== rootId || result.path !== path || !Array.isArray(result.entries) || result.entries.length > 100 ||
          result.entries.some(e => typeof e.name !== "string" || e.name.length > 255 || typeof e.path !== "string" || e.path.length > 1024 ||
            typeof e.directory !== "boolean" || !Number.isSafeInteger(e.size) || e.size < 0 || typeof e.revision !== "string" || e.revision.length > 96) ||
          (result.next !== null && (typeof result.next !== "string" || result.next.length > 64)))
        throw new Error("Invalid directory response.");
      return result;
    },
    async download(rootId: string, entry: RemoteEntry, signal?: AbortSignal) {
      if (downloadId || entry.directory) throw new Error("Download unavailable or already active.");
      const id = crypto.randomUUID(); downloadId = id;
      const received = files.expect(id, signal);
      // Attach a rejection handler before the directory request can fail.
      void received.catch(() => {});
      try {
        await request("download", { rootId, path: entry.path, revision: entry.revision, size: entry.size, transferId: id }, signal);
        const blob = await received;
        if (!valid() || signal?.aborted || downloadId !== id) throw new Error("Download cancelled.");
        const url = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = url; a.download = entry.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) { files.cancel(id); throw error; }
      finally { if (downloadId === id) downloadId = null; }
    },
    cancelDownload() {
      if (!downloadId) return;
      files.cancel(downloadId);
      try { send("download_cancel", crypto.randomUUID(), { transferId: downloadId }); } catch {}
      downloadId = null;
    },
    microphone,
    async verifyOnDevice(scenario) {
      if (verifyRequest) throw new Error("Finish the current verification request first.");
      const id = crypto.randomUUID(); verifyRequest = id;
      update({ verification: "in_progress", requestId: id });
      try {
        await prepareProtected();
        if (!valid() || verifyRequest !== id) throw new Error("Verification cancelled.");
        await request("verification_begin", { scenario }, undefined, id);
      }
      catch (error) {
        try { send("verification_cancel",id); } catch {}
        if (verifyRequest === id) {
          verifyRequest = null; update({ verification: "result_unconfirmed", reason: "Approve on the Windows device. The request was not confirmed; no PIN was released." });
        }
        throw error;
      }
    },
    cancelVerification() {
      if (verifyRequest) { try { send("verification_cancel", verifyRequest); } catch {} }
      verifyRequest = null; update({ verification: "cancelled" });
    },
    finishVerification() {
      if (verifyRequest) { try { send("verification_finish", verifyRequest); } catch {} }
      verifyRequest = null; update({ verification: "result_unconfirmed", reason: "Confirm the application result on the Windows device." });
    },
    close,
  };
}
