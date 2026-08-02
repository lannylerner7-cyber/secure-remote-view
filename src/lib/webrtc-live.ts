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

/** STUN-only. No TURN / external relay service. */
const STUN_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const WEB_CLIENT_KEY = "connectlive.web_client_id";
const CURSOR_KEY = (sessionId: string) => `connectlive.sig_cursor.${sessionId}`;
const HEARTBEAT_MS = 15_000;
/** Ceiling used only while ICE never leaves new/checking. */
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;


export type WebRtcState = "idle" | "connecting" | "connected" | "failed" | "superseded";
export interface WebRtcLive {
  video: HTMLVideoElement;
  state: () => WebRtcState;
  onState: (cb: (s: WebRtcState) => void) => void;
  /** "host" | "srflx" | "prflx" | "relay" once ICE settles, else null. */
  candidateType: () => string | null;
  /** Raw stats for diagnostics (inbound-rtp bytes/framesDecoded). */
  stats: () => Promise<RTCStatsReport | null>;
  sendInput: (payload: unknown) => boolean;
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
  const listeners = new Set<(s: WebRtcState) => void>();
  const setState = (s: WebRtcState) => { state = s; listeners.forEach((cb) => cb(s)); };

  // STUN-only, hardcoded. No external relay service is involved.
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  let dc: RTCDataChannel | null = pc.createDataChannel("inputs", { ordered: true });
  dc.onclose = () => { dc = null; };

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
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    video.srcObject = stream;
  };
  pc.oniceconnectionstatechange = () => {
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
  let closed = false;

  async function drainQueue() {
    if (draining || closed) return;
    draining = true;
    try {
      while (queue.length && !closed) {
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
    queue.push({ kind, payload, attemptId: newAttemptId(), attempts: 0 });
    void drainQueue();
  }

  pc.onicecandidate = (ev) => { if (ev.candidate) enqueue("ice", ev.candidate.toJSON()); };

  // ICE connectivity only proves packets can cross the network. Confirm that
  // the video decoder itself keeps making progress; otherwise return the UI to
  // its JPEG fallback and attempt one clean ICE/media renegotiation.
  mediaWatchdog = window.setInterval(() => {
    if (closed || state !== "connected") return;
    void pc.getStats().then(async (stats) => {
      let decoded = 0;
      let hasInboundVideo = false;
      stats.forEach((r: Record<string, unknown>) => {
        if (r["type"] === "inbound-rtp" && (r["kind"] === "video" || r["mediaType"] === "video")) {
          hasInboundVideo = true;
          decoded = Math.max(decoded, Number(r["framesDecoded"] ?? 0));
        }
      });
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
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          enqueue("offer", { type: offer.type, sdp: offer.sdp });
          return;
        } catch (err) {
          console.warn("[webrtc] media recovery offer failed", err);
        }
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
        if (!row || row.from_side !== "agent" || row.id <= lastSeen) return;
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
    if (closed) return;
    try {
      const res = await bindAdmin({ data: { sessionId, clientId: webClientId } });
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
    if (!first.bound) {
      if (first.reason === "superseded") { setState("superseded"); return; }
      // "not_found" / "not_active" — surface as failed, HTTPS fallback carries UI.
      setState("failed");
      return;
    }
    heartbeatTimer = window.setInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
    armWatchdog();


    try {
      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      enqueue("offer", { type: offer.type, sdp: offer.sdp });
    } catch (err) {
      console.warn("[webrtc] offer failed", err);
      setState("failed");
    }
  })();

  return {
    video,
    state: () => state,
    onState: (cb) => { listeners.add(cb); },
    candidateType: () => selectedCandidateType,
    stats: async () => { try { return await pc.getStats(); } catch { return null; } },
    sendInput: (payload) => {
      if (dc && dc.readyState === "open") {
        try { dc.send(JSON.stringify(payload)); return true; } catch { return false; }
      }
      return false;
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearWatchdog();
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (mediaWatchdog !== null) window.clearInterval(mediaWatchdog);
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
      }).catch(() => undefined).finally(() => {
        try { dc?.close(); } catch {}
        try { pc.close(); } catch {}
        try { supabase.removeChannel(channel); } catch {}
        listeners.clear();
      });
      // Cursor persists across a quick refresh but is discarded when the
      // session actually ends — the caller sets state to superseded/failed.
      if (state === "superseded" || state === "failed") clearCursor(sessionId);
    },
  };
}
