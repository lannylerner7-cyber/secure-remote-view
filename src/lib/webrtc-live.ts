/**
 * Admin-side WebRTC live-view. Sits ON TOP of the existing HTTPS frame stream
 * — if peer connection fails or times out, the <img> fallback keeps rendering.
 *
 * Peer-admin isolation:
 *   - Every browser gets a stable `web_client_id` in localStorage. It acts as
 *     this browser's admin_client_id, in parity with the C# admin's ClientIdStore.
 *   - Before signaling starts we PATCH `sessions.admin_client_id` to bind the
 *     session to this browser. The agent's take-over sequence terminates any
 *     previously-bound admin, so old tabs/consoles see the `terminated` row
 *     and close cleanly.
 *   - Every insert into session_signals carries `admin_client_id`. The DB's
 *     INSERT policy rejects NULL or spoofed IDs (see 20260728 migration).
 *   - The realtime subscription drops rows whose `admin_client_id` does not
 *     match ours (or NULL broadcasts), so two browsers on the same technician
 *     account never cross-wire ICE.
 */
import { supabase } from "@/integrations/supabase/client";

const STUN_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const WEB_CLIENT_KEY = "connectlive.web_client_id";

function loadOrCreateWebClientId(): string {
  try {
    const existing = localStorage.getItem(WEB_CLIENT_KEY);
    if (existing && /^[A-Za-z0-9._:-]{8,64}$/.test(existing)) return existing;
    const fresh = "web-" + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(WEB_CLIENT_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / storage disabled — fall back to an ephemeral id.
    return "web-eph-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export type WebRtcState = "idle" | "connecting" | "connected" | "failed" | "superseded";

export interface WebRtcLive {
  video: HTMLVideoElement;
  state: () => WebRtcState;
  onState: (cb: (s: WebRtcState) => void) => void;
  sendInput: (payload: unknown) => boolean; // returns true if sent via datachannel
  close: () => void;
}

export function startWebRtcLive(sessionId: string): WebRtcLive {
  const webClientId = loadOrCreateWebClientId();

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;";

  let state: WebRtcState = "connecting";
  const listeners = new Set<(s: WebRtcState) => void>();
  const setState = (s: WebRtcState) => {
    state = s;
    listeners.forEach((cb) => cb(s));
  };

  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  let dc: RTCDataChannel | null = pc.createDataChannel("inputs", { ordered: true });
  dc.onopen = () => {};
  dc.onclose = () => { dc = null; };

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    video.srcObject = stream;
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === "connected" || s === "completed") setState("connected");
    else if (s === "failed" || s === "disconnected" || s === "closed") {
      if (state !== "superseded") setState("failed");
    }
  };

  let lastSeenSignal = 0;
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
        if (!row || row.from_side !== "agent" || row.id <= lastSeenSignal) return;
        // Drop rows meant for another admin peer. Untargeted (NULL) is accepted
        // so agent-initiated broadcasts still reach us.
        if (row.admin_client_id && row.admin_client_id !== webClientId) return;
        lastSeenSignal = row.id;
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

  const postSignal = async (kind: "offer" | "ice" | "bye", payload: unknown) => {
    const { error } = await supabase.from("session_signals").insert({
      session_id: sessionId,
      from_side: "admin",
      kind,
      payload: payload as never,
      admin_client_id: webClientId,
    });
    if (error) console.warn("[webrtc] postSignal", kind, error.message);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) void postSignal("ice", ev.candidate.toJSON());
  };

  // Kick off: take-over binding + offer.
  (async () => {
    try {
      // Stamp this session as owned by this browser BEFORE any signaling.
      // The agent will emit `terminated` targeted at the previous admin_client_id.
      await supabase
        .from("sessions")
        .update({ admin_client_id: webClientId })
        .eq("id", sessionId);

      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await postSignal("offer", { type: offer.type, sdp: offer.sdp });
    } catch (err) {
      console.warn("[webrtc] offer failed", err);
      setState("failed");
    }
  })();

  // Watchdog: if not connected in 8s, mark failed so admin UI stays on HTTPS.
  const watchdog = window.setTimeout(() => {
    if (state === "connecting") setState("failed");
  }, 8000);

  return {
    video,
    state: () => state,
    onState: (cb) => { listeners.add(cb); },
    sendInput: (payload) => {
      if (dc && dc.readyState === "open") {
        try { dc.send(JSON.stringify(payload)); return true; } catch { return false; }
      }
      return false;
    },
    close: () => {
      window.clearTimeout(watchdog);
      try { void postSignal("bye", {}); } catch {}
      try { dc?.close(); } catch {}
      try { pc.close(); } catch {}
      try { supabase.removeChannel(channel); } catch {}
      listeners.clear();
    },
  };
}
