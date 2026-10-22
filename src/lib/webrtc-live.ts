/**
 * Admin-side WebRTC live-view with three hardening layers on top of the
 * base SDP/ICE loop:
 *
 *   (1) Retry queue — every outgoing signal (offer / ICE / bye) has a
 *       monotonic `attempt_id` and rides an in-memory FIFO. Transient
 *       failures (network, 5xx, 409 during a take-over race) back off
 *       exponentially; hard errors (400/401/403/404/413) drop the item.
 *       The unique index on (session_id, attempt_id) makes retries idempotent.
 *
 *   (2) Resume across reconnects — a stable `web_client_id` in localStorage
 *       identifies this browser, and the last-seen signal id is kept in
 *       sessionStorage so a page refresh picks up where we left off instead
 *       of replaying `answer` and re-negotiating from scratch.
 *
 *   (3) Heartbeat binding — every 15 s we call the `bind_admin` RPC via
 *       an authenticated server fn. It refreshes admin_bound_at, returns
 *       "superseded" if another admin took the session, and lets the
 *       server-side prune release the binding automatically after 90 s of
 *       silence (crashed browser tab).
 *
 * All writes go through the authenticated `postAdminSignal` server fn — the
 * web console never touches `session_signals` directly.
 */
import { supabase } from "@/integrations/supabase/client";
import { postAdminSignal, bindAdmin } from "@/lib/webrtc-signal.functions";
import { API_ROUTES } from "@/shared/api-routes";
import { RecordingAuthority } from "@/lib/recording-authority";

/** Fallback only. The live set comes from the ICE gateway (S9), which adds
 *  TURN when the deployment has a relay configured. */
const STUN_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const ICE_REQUEST_TIMEOUT_MS = 12_000;
const ICE_FALLBACK_RETRY_MS = 3_000;
type IceConfiguration = { iceServers: RTCIceServer[]; ttlSeconds: number; hasTurn: boolean };
class IceGatewayError extends Error {
  constructor(readonly denied: boolean, readonly retryAfterMs = ICE_FALLBACK_RETRY_MS) {
    super("ICE gateway unavailable");
  }
}

/** Deadline includes auth, HTTP and body parsing, not just the provider's 5s.
 * Race cancellation too: an auth SDK or mocked transport may ignore abort.
 * Never log credentials, server bodies, URLs or thrown transport errors.
 */
async function fetchIceServers(sessionId: string, signal: AbortSignal): Promise<IceConfiguration> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = window.setTimeout(cancel, ICE_REQUEST_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("ICE request cancelled"));
    abort.signal.addEventListener("abort", onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([cancelled, (async () => {
      const { data } = await supabase.auth.getSession();
      if (abort.signal.aborted) throw new Error("ICE request cancelled");
      const token = data.session?.access_token;
      if (!token) throw new IceGatewayError(true);
      const resp = await fetch(`${API_ROUTES.agentIce}?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal, cache: "no-store", redirect: "error",
      });
      if (!resp.ok) throw new IceGatewayError(
        [400, 401, 403, 404].includes(resp.status),
        resp.status === 429 ? 60_000 : ICE_FALLBACK_RETRY_MS,
      );
      const body = await resp.json() as { iceServers?: RTCIceServer[]; ttlSeconds?: number };
      if (!Array.isArray(body.iceServers) || !body.iceServers.length) throw new Error("ICE configuration unavailable");
      const iceServers = body.iceServers;
      const hasTurn = iceServers.some((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some((u) => typeof u === "string" && /^turns?:/i.test(u))
          && typeof s.username === "string" && !!s.username
          && typeof s.credential === "string" && !!s.credential;
      });
      return { iceServers, hasTurn,
        ttlSeconds: typeof body.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds) && body.ttlSeconds > 0
          ? Math.min(body.ttlSeconds, 86400) : 60 };
    })()]);
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    abort.signal.removeEventListener("abort", onAbort);
  }
}
const WEB_CLIENT_KEY = "connectlive.web_client_id";
const CURSOR_KEY = (sessionId: string) => `connectlive.sig_cursor.${sessionId}`;
const HEARTBEAT_MS = 15_000;
/** Ceiling used only while ICE never leaves new/checking. */
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;


export type WebRtcState = "idle" | "connecting" | "connected" | "failed" | "superseded";

/** Step 8 — progress/lifecycle events emitted by the `files` DataChannel. */
export type FileTransferEvent =
  | { kind: "begin"; name: string; size: number }
  | { kind: "progress"; name: string; size: number; sent: number }
  | { kind: "complete"; name: string; size: number; blob: Blob }
  | { kind: "sent"; name: string; size: number }
  | { kind: "error"; name: string; message: string };

/** S24 — one finished local recording of the live track. */
export type RecordingResult = { blob: Blob; mimeType: string; durationMs: number };

export interface WebRtcLive {
  video: HTMLVideoElement;
  state: () => WebRtcState;
  onState: (cb: (s: WebRtcState) => void) => void;
  /** "host" | "srflx" | "prflx" | "relay" once ICE settles, else null. */
  candidateType: () => string | null;
  /** Raw stats for diagnostics (inbound-rtp bytes/framesDecoded). */
  stats: () => Promise<RTCStatsReport | null>;
  /** S16 — "pending" until the ICE gateway answers, then whether a TURN relay is in play. */
  relay: () => "pending" | "relay" | "none";

  sendInput: (payload: unknown) => boolean;
  /** True when the `files` channel is open (datachannel transfer available). */
  filesReady: () => boolean;
  /** Push a local file to the agent over the `files` channel. */
  sendFile: (file: File) => Promise<boolean>;
  /** Subscribe to inbound/outbound transfer events. */
  onFile: (cb: (ev: FileTransferEvent) => void) => () => void;

  // ---- S22 — clipboard sync ---------------------------------------------
  /** True when the `clip` channel is open. */
  clipboardReady: () => boolean;
  /** Push text to the remote clipboard (capped at 256 KiB). */
  sendClipboard: (text: string) => boolean;
  /** Subscribe to clipboard text arriving from the agent. */
  onClipboard: (cb: (text: string) => void) => () => void;

  // ---- S24 — local session recording ------------------------------------
  /** True when MediaRecorder can capture the current track. */
  canRecord: () => boolean;
  recording: () => boolean;
  /** Begin recording the live video track. Returns false when unavailable. */
  startRecording: () => Promise<boolean>;
  onRecording: (callback: (active: boolean) => void) => () => void;
  /** Stop and resolve the finished recording (null when nothing was captured). */
  stopRecording: () => Promise<RecordingResult | null>;

  close: () => void;
}




function getWebClientId(): string {
  try {
    const existing = localStorage.getItem(WEB_CLIENT_KEY);
    if (existing && /^[A-Za-z0-9._:-]{8,64}$/.test(existing)) return existing;
    const fresh = "web-" + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(WEB_CLIENT_KEY, fresh);
    return fresh;
  } catch {
    return "web-eph-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function loadCursor(sessionId: string): number {
  try { return Number(sessionStorage.getItem(CURSOR_KEY(sessionId)) ?? "0") || 0; } catch { return 0; }
}
function saveCursor(sessionId: string, id: number) {
  try { sessionStorage.setItem(CURSOR_KEY(sessionId), String(id)); } catch {}
}
function clearCursor(sessionId: string) {
  try { sessionStorage.removeItem(CURSOR_KEY(sessionId)); } catch {}
}

function newAttemptId() {
  return "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

type QueueItem = {
  kind: "offer" | "ice" | "bye";
  payload: unknown;
  attemptId: string;
  attempts: number;
};

export function startWebRtcLive(sessionId: string): WebRtcLive {
  const webClientId = getWebClientId();

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;";

  let state: WebRtcState = "connecting";
  let closed = false;
  let generation = 0;
  let iceRevision = 0;
  let iceRequest: AbortController | null = null;
  let iceRefreshTimer: number | null = null;
  let fallbackRetries = 0;
  let negotiating = 0;
  const active = () => !closed && state !== "failed" && state !== "superseded";
  const cancelIce = () => {
    generation++;
    iceRevision++;
    iceRequest?.abort();
    iceRequest = null;
    if (iceRefreshTimer !== null) window.clearTimeout(iceRefreshTimer);
    iceRefreshTimer = null;
  };
  const listeners = new Set<(s: WebRtcState) => void>();
  const setState = (s: WebRtcState) => {
    if (closed || (state === "superseded" && s !== "superseded")) return;
    state = s;
    if (s === "failed" || s === "superseded") cancelIce();
    listeners.forEach((cb) => cb(s));
  };

  // Starts on the STUN fallback; the gateway set (STUN + TURN when deployed)
  // is applied via setConfiguration before the first offer, i.e. before ICE
  // gathering begins at setLocalDescription.
  //
  // S16 — the apply is now verified. If setConfiguration is unavailable or
  // rejects the set, the session silently ran STUN-only and every symmetric-NAT
  // network fell back to JPEG with no explanation; `relay()` below reports the
  // truth so the console can say "no relay" instead of "connecting" forever.
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  let relayState: "pending" | "relay" | "none" = "pending";
  let dc: RTCDataChannel | null = pc.createDataChannel("inputs", { ordered: true });
  dc.onclose = () => { dc = null; };

  // ---- Step 8: `files` DataChannel ---------------------------------------
  // Separate, ordered/reliable channel so a multi-megabyte transfer can never
  // head-of-line block the input channel. Wire format: a JSON control frame
  // ("file_begin" / "file_end"), then raw ArrayBuffer chunks in order that
  // belong to the most recent "file_begin".
  const fileChunk = 64 * 1024;
  const fdc: RTCDataChannel = pc.createDataChannel("files", { ordered: true });
  fdc.binaryType = "arraybuffer";
  let incoming: { name: string; mime: string; size: number; parts: ArrayBuffer[]; got: number } | null = null;

  fdc.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data) as Record<string, unknown>;
        if (msg["type"] === "file_begin") {
          incoming = {
            name: String(msg["name"] ?? "file"),
            mime: String(msg["mime"] ?? "application/octet-stream"),
            size: Number(msg["size"] ?? 0),
            parts: [],
            got: 0,
          };
          fileListeners.forEach((cb) => cb({ kind: "begin", name: incoming!.name, size: incoming!.size }));
        } else if (msg["type"] === "file_end" && incoming) {
          const done = incoming;
          incoming = null;
          const blob = new Blob(done.parts, { type: done.mime });
          fileListeners.forEach((cb) => cb({ kind: "complete", name: done.name, size: blob.size, blob }));
        } else if (msg["type"] === "file_error") {
          incoming = null;
          fileListeners.forEach((cb) => cb({ kind: "error", name: String(msg["name"] ?? ""), message: String(msg["message"] ?? "transfer failed") }));
        }
      } catch { /* ignore malformed control frame */ }
      return;
    }
    if (!incoming) return;
    const buf = ev.data as ArrayBuffer;
    incoming.parts.push(buf);
    incoming.got += buf.byteLength;
    const rec = incoming;
    fileListeners.forEach((cb) => cb({ kind: "progress", name: rec.name, size: rec.size, sent: rec.got }));
  };

  const fileListeners = new Set<(ev: FileTransferEvent) => void>();

  /** Push a local file to the agent, yielding to the SCTP buffer as it fills. */
  async function sendFileOverChannel(file: File): Promise<boolean> {
    if (fdc.readyState !== "open") return false;
    try {
      fdc.send(JSON.stringify({ type: "file_begin", name: file.name, size: file.size, mime: file.type }));
      let offset = 0;
      while (offset < file.size) {
        while (fdc.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 20));
          if (fdc.readyState !== "open") return false;
        }
        const slice = await file.slice(offset, offset + fileChunk).arrayBuffer();
        fdc.send(slice);
        offset += slice.byteLength;
        fileListeners.forEach((cb) => cb({ kind: "progress", name: file.name, size: file.size, sent: offset }));
      }
      fdc.send(JSON.stringify({ type: "file_end", name: file.name, size: file.size }));
      fileListeners.forEach((cb) => cb({ kind: "sent", name: file.name, size: file.size }));
      return true;
    } catch {
      return false;
    }
  }

  // ---- S22: `clip` DataChannel -------------------------------------------
  // Third reliable/ordered channel, text only and hard-capped. Kept separate
  // from `inputs` so a large paste can never delay a mouseup, and separate
  // from `files` so a multi-megabyte transfer can never delay a paste.
  const CLIP_MAX = 256 * 1024;
  const cdc: RTCDataChannel = pc.createDataChannel("clip", { ordered: true });
  const clipListeners = new Set<(text: string) => void>();
  let lastClipApplied = "";

  cdc.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as Record<string, unknown>;
      if (msg["type"] !== "clip") return;
      const text = String(msg["text"] ?? "").slice(0, CLIP_MAX);
      if (!text || text === lastClipApplied) return;
      lastClipApplied = text;
      clipListeners.forEach((cb) => cb(text));
    } catch { /* ignore malformed clip frame */ }
  };

  function sendClipboardText(text: string): boolean {
    if (cdc.readyState !== "open") return false;
    const trimmed = text.slice(0, CLIP_MAX);
    if (!trimmed) return false;
    try {
      lastClipApplied = trimmed; // suppress the echo when the agent mirrors it back
      cdc.send(JSON.stringify({ type: "clip", text: trimmed }));
      return true;
    } catch {
      return false;
    }
  }

  // ---- S24: local session recording --------------------------------------
  // MediaRecorder taps the already-decoded inbound track, so recording costs
  // no extra bandwidth and no extra agent work. The blob stays in the browser
  // — the caller decides whether to download it or upload it as evidence.
  const RECORD_MIME_CANDIDATES = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  let recorder: MediaRecorder | null = null;
  let recordChunks: Blob[] = [];
  let recordStartedAt = 0;
  let recordingBusy = false;
  let recordExpiry: number | null = null;
  let recordRenew: number | null = null;
  let renewBusy = false;
  const recordingListeners = new Set<(active: boolean) => void>();
  const recordAuthority = new RecordingAuthority(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token || closed) return null;
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 3000);
    try {
      const response = await fetch(API_ROUTES.adminSessionAuthorization(sessionId), {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store", redirect: "error", signal: abort.signal,
      });
      if (!response.ok) return null;
      const result = await response.json();
      return result.allowed === true && result.capabilities?.recording === true
        && typeof result.authorizationId === "string"
        && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.authorizationId)
        ? result.authorizationId : null;
    } catch { return null; }
    finally { window.clearTimeout(timer); }
  });

  function clearRecordingTimers() {
    if (recordExpiry !== null) window.clearInterval(recordExpiry);
    if (recordRenew !== null) window.clearInterval(recordRenew);
    recordExpiry = recordRenew = null;
  }
  function abandonRecording() {
    recordAuthority.invalidate();
    clearRecordingTimers();
    recordChunks = [];
    const rec = recorder;
    recorder = null;
    recordingListeners.forEach((callback) => callback(false));
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      try { rec.stop(); } catch { /* already stopped */ }
    }
  }

  function pickRecordMime(): string | null {
    if (typeof MediaRecorder === "undefined") return null;
    for (const m of RECORD_MIME_CANDIDATES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* older browsers */ }
    }
    return null;
  }

  function recordableStream(): MediaStream | null {
    const src = video.srcObject;
    if (!(src instanceof MediaStream)) return null;
    return src.getVideoTracks().length > 0 ? src : null;
  }

  async function startRecordingInternal(): Promise<boolean> {
    if (closed || recordingBusy) return false;
    if (recorder) return true;
    const stream = recordableStream();
    const mimeType = pickRecordMime();
    if (!stream || !mimeType) return false;
    recordingBusy = true;
    try {
      if (!(await recordAuthority.authorize()) || closed) return false;
      const rec = new MediaRecorder(stream, { mimeType });
      recordChunks = [];
      rec.ondataavailable = (ev) => {
        if (!recordAuthority.valid() || closed) { abandonRecording(); return; }
        if (ev.data && ev.data.size > 0) recordChunks.push(ev.data);
      };
      rec.start(1000); // flush a chunk per second so a crash still leaves footage
      recorder = rec;
      recordingListeners.forEach((callback) => callback(true));
      recordStartedAt = Date.now();
      recordExpiry = window.setInterval(() => {
        if (!recordAuthority.valid() || closed) abandonRecording();
      }, 100);
      recordRenew = window.setInterval(async () => {
        if (renewBusy || recordingBusy || !recorder) return;
        renewBusy = true;
        try {
          const allowed = await recordAuthority.authorize(true);
          if (!allowed && recorder === rec) abandonRecording();
        } finally { renewBusy = false; }
      }, 2000);
      return true;
    } catch (err) {
      abandonRecording();
      console.warn("[webrtc] recording failed to start", err);
      return false;
    } finally { recordingBusy = false; }
  }

  async function stopRecordingInternal(): Promise<RecordingResult | null> {
    if (recordingBusy) return null;
    const rec = recorder;
    if (!rec) return null;
    recordingBusy = true;
    if (!(await recordAuthority.authorize(true)) || closed || recorder !== rec) {
      abandonRecording(); recordingBusy = false; return null;
    }
    recorder = null;
    recordingListeners.forEach((callback) => callback(false));
    clearRecordingTimers();
    const mimeType = rec.mimeType || "video/webm";
    const durationMs = Date.now() - recordStartedAt;
    return new Promise((resolve) => {
      rec.onstop = () => {
        const parts = recordChunks;
        recordChunks = [];
        const permitted = recordAuthority.valid() && !closed;
        recordAuthority.invalidate();
        recordingBusy = false;
        if (!permitted || parts.length === 0) { resolve(null); return; }
        resolve({ blob: new Blob(parts, { type: mimeType }), mimeType, durationMs });
      };
      try { rec.stop(); } catch { abandonRecording(); recordingBusy = false; resolve(null); }
    });
  }


  let selectedCandidateType: string | null = null;
  const connectTimeoutMs = CONNECT_TIMEOUT_MS;
  let watchdog: number | null = null;
  let mediaWatchdog: number | null = null;
  let connectedAt = 0;
  let lastDecodedFrames = 0;
  let lastMediaProgressAt = 0;
  let mediaRecoveryAttempted = false;

  const clearWatchdog = () => {
    if (watchdog !== null) { window.clearTimeout(watchdog); watchdog = null; }
  };

  /**
   * The watchdog only guards the "ICE never even started checking" case.
   * Reaching `checking` is real progress (relay allocation can be slow), so
   * we disarm it there and let ICE's own `failed` be authoritative.
   */
  const armWatchdog = () => {
    if (!active()) return;
    clearWatchdog();
    watchdog = window.setTimeout(() => {
      const s = pc.iceConnectionState;
      if (state === "connecting" && (s === "new" || s === "checking")) {
        console.warn(`[webrtc] no ICE progress in ${connectTimeoutMs}ms (iceState=${s})`);
        setState("failed");
      }
    }, connectTimeoutMs);
  };

  async function reportCandidatePair() {
    try {
      const stats = await pc.getStats();
      if (!active()) return;
      let pairId: string | null = null;
      stats.forEach((r: Record<string, unknown>) => {
        if (r["type"] === "transport" && typeof r["selectedCandidatePairId"] === "string") {
          pairId = r["selectedCandidatePairId"] as string;
        }
      });
      let localId: string | null = null;
      let remoteId: string | null = null;
      stats.forEach((r: Record<string, unknown>) => {
        const isSelected = r["type"] === "candidate-pair" &&
          (r["id"] === pairId || (!pairId && r["selected"] === true) || (!pairId && r["state"] === "succeeded" && r["nominated"] === true));
        if (isSelected) {
          localId = r["localCandidateId"] as string;
          remoteId = r["remoteCandidateId"] as string;
        }
      });
      let local: string | null = null;
      let remote: string | null = null;
      stats.forEach((r: Record<string, unknown>) => {
        if (r["id"] === localId) local = (r["candidateType"] as string) ?? null;
        if (r["id"] === remoteId) remote = (r["candidateType"] as string) ?? null;
      });
      selectedCandidateType = local === "relay" || remote === "relay" ? "relay" : local ?? remote;
      console.info(`[webrtc] ice pair local=${local} remote=${remote} -> ${selectedCandidateType}`);
      listeners.forEach((cb) => cb(state));
    } catch (err) {
      console.warn("[webrtc] getStats failed", err);
    }
  }

  pc.ontrack = (ev) => {
    if (!active()) return;
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    video.srcObject = stream;
  };
  pc.oniceconnectionstatechange = () => {
    if (!active()) return;
    const s = pc.iceConnectionState;
    console.info("[webrtc] iceConnectionState:", s);
    if (s === "checking") {
      // Progress: restart the clock once, then rely on ICE's own verdict.
      armWatchdog();
      return;
    }
    if (s === "connected" || s === "completed") {
      clearWatchdog();
      connectedAt = Date.now();
      lastMediaProgressAt = connectedAt;
      setState("connected");
      void reportCandidatePair();
      return;
    }
    if (state === "superseded") return;
    if (s === "failed" || s === "closed" || s === "disconnected") {
      clearWatchdog();
      setState("failed");
    }
  };



  // ---- Retry queue --------------------------------------------------------
  const queue: QueueItem[] = [];
  let draining = false;

  async function drainQueue() {
    if (draining || !active()) return;
    draining = true;
    try {
      while (queue.length && active()) {
        const item = queue[0];
        try {
          const res = await postAdminSignal({
            data: {
              sessionId,
              clientId: webClientId,
              kind: item.kind,
              payload: item.payload,
              attemptId: item.attemptId,
            },
          });
          if (!active()) return;
          if (res.ok) { queue.shift(); continue; }
          if (res.error === "superseded") {
            queue.length = 0;
            setState("superseded");
            return;
          }
          if (res.error === "forbidden" || res.error === "not_found") {
            console.warn("[webrtc] server rejected signal:", res.error);
            queue.shift();
            continue;
          }
          // "not_active" / "insert_failed" — retry with backoff.
          throw new Error(res.error);
        } catch (err) {
          if (!active()) return;
          item.attempts++;
          if (item.attempts >= MAX_ATTEMPTS) {
            console.warn("[webrtc] giving up on", item.kind, "after", item.attempts, "tries", err);
            queue.shift();
            continue;
          }
          const backoff = Math.min(4000, 250 * 2 ** (item.attempts - 1));
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    } finally {
      draining = false;
    }
  }

  function enqueue(kind: "offer" | "ice" | "bye", payload: unknown) {
    if (!active()) return;
    queue.push({ kind, payload, attemptId: newAttemptId(), attempts: 0 });
    void drainQueue();
  }

  pc.onicecandidate = (ev) => { if (ev.candidate) enqueue("ice", ev.candidate.toJSON()); };

  /** Every restart obtains a new session-scoped set before allocating ICE.
   * Expiry refreshes only update configuration for future allocations; they
   * never disturb a working media path. One delayed STUN-fallback retry is
   * allowed per live view, not an endless retry loop during an outage.
   */
  async function refreshIce(): Promise<boolean> {
    if (!active()) return false;
    const revision = ++iceRevision;
    iceRequest?.abort();
    const request = new AbortController();
    iceRequest = request;
    if (iceRefreshTimer !== null) window.clearTimeout(iceRefreshTimer);
    iceRefreshTimer = null;
    const startedAt = Date.now();
    let config: IceConfiguration | null = null;
    let retryAfterMs = ICE_FALLBACK_RETRY_MS;
    try {
      config = await fetchIceServers(sessionId, request.signal);
    } catch (error) {
      if (!active() || revision !== iceRevision) return false;
      if (error instanceof IceGatewayError) {
        if (error.denied) {
          relayState = "none";
          console.warn("[webrtc] ICE session authorization rejected");
          setState("failed");
          return false;
        }
        retryAfterMs = error.retryAfterMs;
      }
      console.warn("[webrtc] ICE gateway unavailable; using direct paths only");
    }
    if (!active() || revision !== iceRevision) return false;
    iceRequest = null;
    try {
      pc.setConfiguration({ iceServers: config?.iceServers ?? STUN_SERVERS });
      relayState = config?.hasTurn ? "relay" : "none";
    } catch {
      relayState = "none";
      config = null;
      // Do not leave previously-applied, possibly-expired relay credentials.
      try { pc.setConfiguration({ iceServers: STUN_SERVERS }); } catch {
        setState("failed");
        return false;
      }
      console.warn("[webrtc] ICE configuration rejected; using direct paths only");
    }
    if (relayState === "relay" && config) {
      const ttlMs = config.ttlSeconds * 1000;
      const margin = Math.min(30_000, ttlMs * 0.2);
      const delay = Math.max(1000, ttlMs - margin - (Date.now() - startedAt));
      iceRefreshTimer = window.setTimeout(() => { void refreshIce(); }, delay);
    } else if (fallbackRetries < 1) {
      fallbackRetries++;
      iceRefreshTimer = window.setTimeout(async () => {
        if (!active()) return;
        // The offer watchdog must not cut short this request's 12s budget.
        if (state === "connecting") clearWatchdog();
        const previousGeneration = generation;
        if (await refreshIce() && active() && previousGeneration === generation && relayState === "relay") {
          // New credentials must participate in gathering, not just sit on pc.
          await negotiate(true, false);
        } else if (active() && state === "connecting" && previousGeneration === generation) {
          armWatchdog();
        }
      }, retryAfterMs);
    }
    return true;
  }

  async function negotiate(restart: boolean, refresh = true): Promise<void> {
    if (!active()) return;
    const current = ++generation;
    negotiating++;
    const valid = () => active() && current === generation;
    clearWatchdog();
    try {
      if (refresh && !(await refreshIce())) return;
      if (!valid()) return;
      if (!restart) pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
      if (!valid()) return;
      await pc.setLocalDescription(offer);
      if (!valid()) return;
      enqueue("offer", { type: offer.type, sdp: offer.sdp });
      if (state === "connecting") armWatchdog();
    } catch {
      if (!valid()) return;
      console.warn("[webrtc] offer failed");
      setState("failed");
    } finally {
      negotiating--;
    }
  }

  // ICE connectivity only proves packets can cross the network. Confirm that
  // the video decoder itself keeps making progress; otherwise return the UI to
  // its JPEG fallback and attempt one clean ICE/media renegotiation.
  mediaWatchdog = window.setInterval(() => {
    if (closed || state !== "connected" || negotiating) return;
    void pc.getStats().then(async (stats) => {
      if (!active() || state !== "connected") return;
      let decoded = 0;
      let hasInboundVideo = false;
      // Step 1 diagnostics: loss/keyframe/geometry counters alongside framesDecoded.
      let probe: Record<string, unknown> | null = null;
      stats.forEach((r: Record<string, unknown>) => {
        if (r["type"] === "inbound-rtp" && (r["kind"] === "video" || r["mediaType"] === "video")) {
          hasInboundVideo = true;
          decoded = Math.max(decoded, Number(r["framesDecoded"] ?? 0));
          probe = {
            framesDecoded: r["framesDecoded"],
            keyFramesDecoded: r["keyFramesDecoded"],
            framesDropped: r["framesDropped"],
            framesReceived: r["framesReceived"],
            packetsReceived: r["packetsReceived"],
            packetsLost: r["packetsLost"],
            pliCount: r["pliCount"],
            nackCount: r["nackCount"],
            bytesReceived: r["bytesReceived"],
            frameWidth: r["frameWidth"],
            frameHeight: r["frameHeight"],
          };
        }
      });
      if (probe) console.info("[webrtc][diag]", JSON.stringify(probe));
      const now = Date.now();
      if (decoded > lastDecodedFrames) {
        lastDecodedFrames = decoded;
        lastMediaProgressAt = now;
        return;
      }
      if (!hasInboundVideo && now - connectedAt < 8_000) return;
      if (now - lastMediaProgressAt < 8_000) return;


      if (!mediaRecoveryAttempted) {
        mediaRecoveryAttempted = true;
        lastMediaProgressAt = now;
        console.warn("[webrtc] decoded video stalled; requesting one clean renegotiation");
        await negotiate(true);
        return;
      }

      console.warn("[webrtc] decoded video remained stalled; activating frame fallback");
      setState("failed");
      try { pc.close(); } catch {}
    }).catch((err) => console.warn("[webrtc] media watchdog stats failed", err));
  }, 3_000);

  // ---- Inbound signals (postgres_changes; broadcast-tier can be added later)
  let lastSeen = loadCursor(sessionId);
  const channel = supabase
    .channel(`signals-${sessionId}-${webClientId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "session_signals", filter: `session_id=eq.${sessionId}` },
      async (payload) => {
        const row = payload.new as {
          id: number;
          from_side: string;
          kind: string;
          payload: unknown;
          admin_client_id: string | null;
        };
        if (!active() || !row || row.from_side !== "agent" || row.id <= lastSeen) return;
        if (row.admin_client_id && row.admin_client_id !== webClientId) return;
        lastSeen = row.id;
        saveCursor(sessionId, row.id);
        try {
          if (row.kind === "answer") {
            await pc.setRemoteDescription(row.payload as RTCSessionDescriptionInit);
          } else if (row.kind === "ice") {
            await pc.addIceCandidate(row.payload as RTCIceCandidateInit);
          } else if (row.kind === "terminated") {
            setState("superseded");
            try { dc?.close(); } catch {}
            try { pc.close(); } catch {}
          } else if (row.kind === "bye") {
            setState("failed");
          }
        } catch (err) {
          console.warn("[webrtc] signal apply failed", err);
        }
      },
    )
    .subscribe();

  // ---- Heartbeat + kickoff ------------------------------------------------
  let heartbeatTimer: number | null = null;
  async function heartbeat() {
    if (!active()) return;
    try {
      const res = await bindAdmin({ data: { sessionId, clientId: webClientId } });
      if (!active()) return;
      if (!res.bound && res.reason === "superseded") {
        setState("superseded");
        return;
      }
    } catch (err) {
      console.warn("[webrtc] heartbeat failed", err);
    }
  }

  (async () => {
    // Claim (or refresh) the binding BEFORE the first offer. The agent's
    // take-over logic will emit `terminated` at any previously-bound admin.
    const first = await bindAdmin({ data: { sessionId, clientId: webClientId } });
    if (!active()) return;
    if (!first.bound) {
      if (first.reason === "superseded") { setState("superseded"); return; }
      // "not_found" / "not_active" — surface as failed, HTTPS fallback carries UI.
      setState("failed");
      return;
    }
    heartbeatTimer = window.setInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
    await negotiate(false);
  })().catch(() => {
    if (!active()) return;
    console.warn("[webrtc] startup binding failed");
    setState("failed");
  });

  return {
    video,
    state: () => state,
    onState: (cb) => { listeners.add(cb); },
    candidateType: () => selectedCandidateType,
    stats: async () => { try { return await pc.getStats(); } catch { return null; } },
    relay: () => relayState,

    sendInput: (payload) => {
      if (dc && dc.readyState === "open") {
        try { dc.send(JSON.stringify(payload)); return true; } catch { return false; }
      }
      return false;
    },
    filesReady: () => fdc.readyState === "open",
    sendFile: (file) => sendFileOverChannel(file),
    onFile: (cb) => { fileListeners.add(cb); return () => { fileListeners.delete(cb); }; },

    clipboardReady: () => cdc.readyState === "open",
    sendClipboard: (text) => sendClipboardText(text),
    onClipboard: (cb) => { clipListeners.add(cb); return () => { clipListeners.delete(cb); }; },

    canRecord: () => pickRecordMime() !== null && recordableStream() !== null,
    recording: () => recorder !== null,
    onRecording: (callback) => {
      recordingListeners.add(callback);
      return () => { recordingListeners.delete(callback); };
    },
    startRecording: () => startRecordingInternal(),
    stopRecording: () => stopRecordingInternal(),

    close: () => {
      if (closed) return;
      closed = true;
      cancelIce();
      queue.length = 0;
      clearWatchdog();
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (mediaWatchdog !== null) window.clearInterval(mediaWatchdog);
      // S24 — never strand an in-flight recording; stop it before the track dies.
      abandonRecording();
      // Local teardown must not wait for an unresponsive final-signal request.
      try { dc?.close(); } catch {}
      try { pc.close(); } catch {}
      try { supabase.removeChannel(channel); } catch {}

      // Send the final signal directly: the normal queue stops accepting work
      // once close begins, and a queued bye could otherwise be stranded.
      void postAdminSignal({
        data: {
          sessionId,
          clientId: webClientId,
          kind: "bye",
          payload: {},
          attemptId: newAttemptId(),
        },
      }).catch(() => undefined);
      listeners.clear();
      // Cursor persists across a quick refresh but is discarded when the
      // session actually ends — the caller sets state to superseded/failed.
      if (state === "superseded" || state === "failed") clearCursor(sessionId);
    },
  };
}
