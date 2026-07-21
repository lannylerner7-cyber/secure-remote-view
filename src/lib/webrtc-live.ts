/**
 * Admin-side WebRTC live-view. Sits ON TOP of the existing HTTPS frame stream
 * — if peer connection fails or times out, the <img> fallback keeps rendering.
 *
 * Signaling: writes admin offers/ICE candidates into `session_signals` and
 * subscribes to agent rows via Supabase Realtime.
 * Inputs: prefer reliable+ordered RTCDataChannel; caller falls back to HTTPS.
 */
import { supabase } from "@/integrations/supabase/client";

const STUN_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type WebRtcState = "idle" | "connecting" | "connected" | "failed";

export interface WebRtcLive {
  video: HTMLVideoElement;
  state: () => WebRtcState;
  onState: (cb: (s: WebRtcState) => void) => void;
  sendInput: (payload: unknown) => boolean; // returns true if sent via datachannel
  close: () => void;
}

export function startWebRtcLive(sessionId: string): WebRtcLive {
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
    else if (s === "failed" || s === "disconnected" || s === "closed") setState("failed");
  };

  let lastSeenSignal = 0;
  const channel = supabase
    .channel(`signals-${sessionId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "session_signals", filter: `session_id=eq.${sessionId}` },
      async (payload) => {
        const row = payload.new as { id: number; from_side: string; kind: string; payload: unknown };
        if (!row || row.from_side !== "agent" || row.id <= lastSeenSignal) return;
        lastSeenSignal = row.id;
        try {
          if (row.kind === "answer") {
            await pc.setRemoteDescription(row.payload as RTCSessionDescriptionInit);
          } else if (row.kind === "ice") {
            await pc.addIceCandidate(row.payload as RTCIceCandidateInit);
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
    await supabase.from("session_signals").insert({
      session_id: sessionId,
      from_side: "admin",
      kind,
      payload: payload as never,
    });
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) void postSignal("ice", ev.candidate.toJSON());
  };

  // Kick off the offer.
  (async () => {
    try {
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
