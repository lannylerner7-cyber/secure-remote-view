import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { sendTelegramNotify } from "@/lib/notify.functions";
import { getMyRole, type AppRole } from "@/lib/admins.functions";

import { NotificationBell } from "@/components/NotificationBell";
import { Button } from "@/components/ui/button";

import { startWebRtcLive, type WebRtcLive, type WebRtcState } from "@/lib/webrtc-live";
import type { Tables } from "@/integrations/supabase/types";
import {
  type Device,
  type Session,
  type LiveFrame,
  type LiveCursor,
  type Nav,
  NAV_VALUES,
  STALE_MS,
  OFFLINE_MS,
} from "@/lib/console-types";
import { keyToVirtualKey, getContainedPoint } from "@/lib/console-input";
import { VirtualTrackpad } from "@/components/console/VirtualTrackpad";
import { OnScreenKeyboard } from "@/components/console/OnScreenKeyboard";
import { SessionFilesPanel } from "@/components/console/SessionFilesPanel";

import { StatCard } from "@/components/console/StatCard";
import { DevicesTable } from "@/components/console/DevicesTable";
import { SessionsTable } from "@/components/console/SessionsTable";
import { TelegramSettings } from "@/components/console/TelegramSettings";
import { TeamPanel } from "@/components/console/TeamPanel";
import { ReaperPanel } from "@/components/console/ReaperPanel";
import { ExpectedDevicesPanel } from "@/components/console/ExpectedDevicesPanel";
import { RenderHealthPanel } from "@/components/console/RenderHealthPanel";
import { RemoteCursorOverlay } from "@/components/console/RemoteCursorOverlay";
import { MonitorPicker, type MonitorEntry } from "@/components/console/MonitorPicker";


export const Route = createFileRoute("/_authenticated/console")({
  component: AdminPage,
  head: () => ({
    meta: [
      { title: "Technician console — ConnectLive" },
      {
        name: "description",
        content:
          "ConnectLive technician console: enrolled devices, consent-gated live sessions, remote input, power commands and payment administration.",
      },
      { property: "og:title", content: "Technician console — ConnectLive" },
      {
        property: "og:description",
        content: "Live device fleet, consent-gated remote sessions and session history.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://connectliveagent.com/console" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://connectliveagent.com/console" }],
  }),
  validateSearch: (raw: Record<string, unknown>): { tab?: Nav } => {
    const t = typeof raw.tab === "string" ? raw.tab : undefined;
    return t && (NAV_VALUES as readonly string[]).includes(t) ? { tab: t as Nav } : {};
  },
});



function AdminPage() {
  const navigate = useNavigate();
  const notify = useServerFn(sendTelegramNotify);
  const fetchRole = useServerFn(getMyRole);
  const [role, setRole] = useState<AppRole | null>(null);
  const liveSurfaceRef = useRef<HTMLDivElement | null>(null);
  const rtcRef = useRef<WebRtcLive | null>(null);
  /** S21 — true while the reliable `files` DataChannel is open. */
  const [filesReady, setFilesReady] = useState(false);
  /** S22 — true while the `clip` DataChannel is open. */
  const [clipReady, setClipReady] = useState(false);
  /** S24 — true while a local recording of the live track is running. */
  const [recording, setRecording] = useState(false);

  const videoHostRef = useRef<HTMLDivElement | null>(null);
  const mouseButtonDownRef = useRef(false);
  // rAF pointer-move coalescer: only the latest position is flushed per frame.
  const pendingMoveRef = useRef<{
    sessionId: string;
    kind: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const moveRafRef = useRef<number | null>(null);
  // Relative-motion pointer (pointer-lock): admin hides the OS cursor and
  // ships mouse deltas as `mousemove_rel`. The agent translates that into
  // MOUSEEVENTF_MOVE (no ABSOLUTE flag) so the remote pointer moves with the
  // OS's own acceleration curve — feels native, ignores the letterbox.
  const [pointerLocked, setPointerLocked] = useState(false);
  const pointerLockRelRef = useRef({ dx: 0, dy: 0 });

  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<Tables<"audit_logs">[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [userId, setUserId] = useState<string | null>(null);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null);
  const fpsCounterRef = useRef({ count: 0, lastReset: Date.now(), fps: 0 });
  const lastRealtimePushAtRef = useRef<number>(0);
  const [realtimeStatus, setRealtimeStatus] = useState<
    "connecting" | "subscribed" | "reconnecting" | "closed"
  >("connecting");
  // WebRTC video is the primary surface; the JPEG frame pipe is the fallback.
  const [rtcState, setRtcState] = useState<WebRtcState>("idle");
  const rtcVideoLive = rtcState === "connected";
  const rtcVideoLiveRef = useRef(false);
  // When the video track drops we unsubscribe/resubscribe the JPEG fallback,
  // so `liveFrame` is momentarily ancient. Remember the drop instant and grant
  // a grace window instead of screaming "Stalled" at a session that is fine.
  const rtcDroppedAtRef = useRef<number>(0);
  if (rtcVideoLiveRef.current && !rtcVideoLive) rtcDroppedAtRef.current = Date.now();
  rtcVideoLiveRef.current = rtcVideoLive;
  // Decoded-video frame rate, sampled off the real <video> element so the HUD
  // reports the stream's actual cadence rather than the JPEG fallback's.
  const videoFpsRef = useRef({ last: 0, frames: 0, fps: 0 });
  const [videoFps, setVideoFps] = useState(0);
  // "Connected" is not the same as "showing pixels": a peer can complete ICE
  // while the sender's encoder emits nothing. Only a decoded frame proves the
  // video surface is real — until then we keep the JPEG fallback alive and
  // label the transport honestly.
  const [videoDecoding, setVideoDecoding] = useState(false);
  const videoDecodingRef = useRef(false);
  videoDecodingRef.current = videoDecoding;

  const [liveCursor, setLiveCursor] = useState<LiveCursor | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const search = Route.useSearch();
  const [nav, setNav] = useState<Nav>(search.tab ?? "dashboard");
  const [sharedNote, setSharedNote] = useState<string>("");
  const [tg, setTg] = useState({
    telegram_bot_token: "",
    telegram_chat_id: "",
    notify_on_session_start: true,
    notify_on_control_taken: true,
    notify_on_device_offline: true,
    notify_on_agent_stopped: true,
  });
  const [tgSaved, setTgSaved] = useState<null | "saved" | "testing" | "test_ok" | "test_fail">(
    null,
  );

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? "");
      setUserId(data.user?.id ?? null);
    });
    void refresh();
    void loadTg();
    fetchRole()
      .then((r) => {
        setRole(r.role);
      })
      .catch(() => setRole(null));
    const ch = supabase
      .channel("admin-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "audit_logs" }, refresh)
      .subscribe();
    const t = setInterval(refresh, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(t);
      clearInterval(clock);
    };
  }, []);

  // Live surface subscriptions.
  //   * Cursor telemetry always streams (it is tiny and drives the SVG overlay).
  //   * JPEG frames (session_frames) are the FALLBACK surface only — while the
  //     WebRTC video track is connected we unsubscribe from them entirely and
  //     stop the poller, so the slideshow pipe costs nothing. It resumes
  //     automatically the moment RTC drops to failed/superseded.
  useEffect(() => {
    if (!liveId) {
      setLiveFrame(null);
      setLiveCursor(null);
      setSharedNote("");
      setRealtimeStatus("connecting");
      return;
    }
    let cancelled = false;
    // Only stand down the JPEG pipe once video is genuinely decoding.
    const wantFrames = !videoDecoding;

    setRealtimeStatus("connecting");
    lastRealtimePushAtRef.current = 0;
    if (wantFrames) {
      supabase
        .from("session_frames")
        .select("frame,width,height,updated_at")
        .eq("session_id", liveId)
        .maybeSingle()
        .then(({ data }) => {
          if (!cancelled && data) setLiveFrame(data as never);
        });
    }
    supabase
      .from("session_cursors")
      .select("x,y,frame_w,frame_h,kind,visible,updated_at")
      .eq("session_id", liveId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setLiveCursor(data as never);
      });
    let ch = supabase.channel(`frames-${liveId}-${wantFrames ? "full" : "cursor"}`);
    if (wantFrames) {
      ch = ch.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "session_frames",
          filter: `session_id=eq.${liveId}`,
        },
        (payload) => {
          const row = payload.new as never as LiveFrame;
          if (row) {
            setLiveFrame(row);
            lastRealtimePushAtRef.current = Date.now();
            // FPS counter
            const c = fpsCounterRef.current;
            c.count++;
            const elapsed = Date.now() - c.lastReset;
            if (elapsed >= 1000) {
              c.fps = Math.round((c.count * 1000) / elapsed);
              c.count = 0;
              c.lastReset = Date.now();
            }
          }
        },
      );
    }
    ch = ch.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "session_cursors", filter: `session_id=eq.${liveId}` },
      (payload) => {
        const row = payload.new as never as LiveCursor;
        if (row) {
          setLiveCursor(row);
          lastRealtimePushAtRef.current = Date.now();
        }
      },
    );
    ch.subscribe((status) => {
      if (cancelled) return;
      if (status === "SUBSCRIBED") setRealtimeStatus("subscribed");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
        setRealtimeStatus("reconnecting");
      else if (status === "CLOSED") setRealtimeStatus("closed");
    });
    // Fallback poller: only fetches when the realtime socket has been quiet
    // for >5s, so we can prove the pipe is alive even when postgres_changes drops.
    const poll = setInterval(async () => {
      if (cancelled) return;
      if (Date.now() - lastRealtimePushAtRef.current < 5000) return;
      const [{ data: f }, { data: c }] = await Promise.all([
        wantFrames
          ? supabase
              .from("session_frames")
              .select("frame,width,height,updated_at")
              .eq("session_id", liveId)
              .maybeSingle()
          : Promise.resolve({ data: null } as { data: null }),
        supabase
          .from("session_cursors")
          .select("x,y,frame_w,frame_h,kind,visible,updated_at")
          .eq("session_id", liveId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      if (f) setLiveFrame(f as never);
      if (c) setLiveCursor(c as never);
    }, 3000);
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
      clearInterval(poll);
    };
  }, [liveId, videoDecoding]);

  useEffect(() => {
    if (!liveId) {
      rtcRef.current?.close();
      rtcRef.current = null;
      setRtcState("idle");
      setFilesReady(false);
      return;
    }
    const live = startWebRtcLive(liveId);
    rtcRef.current = live;
    setRtcState(live.state());
    live.onState((s) => {
      if (rtcRef.current === live) setRtcState(s);
    });

    // S21 — inbound transfers must announce themselves even when the Files
    // drawer is closed, and the HUD needs to say whether the reliable `files`
    // channel is actually available (datachannel) or the session is on the
    // HTTP archive fallback.
    let toastId: string | number | undefined;
    const offFile = live.onFile((ev) => {
      if (rtcRef.current !== live) return;
      if (ev.kind === "begin") {
        toastId = toast.loading(`Receiving ${ev.name}…`);
      } else if (ev.kind === "complete") {
        toast.success(`Received ${ev.name}`, {
          id: toastId,
          description: `${(ev.size / 1024).toFixed(0)} KB · saved to the session transcript`,
        });
        toastId = undefined;
      } else if (ev.kind === "error") {
        toast.error(`Transfer failed: ${ev.name || "file"}`, {
          id: toastId,
          description: ev.message,
        });
        toastId = undefined;
      }
    });

    // S22 — clipboard arriving from the remote machine. We mirror it into the
    // technician's own clipboard when the browser allows it (needs a secure
    // context and clipboard-write permission); otherwise the toast still shows
    // the text so it can be copied by hand.
    const offClip = live.onClipboard((text) => {
      if (rtcRef.current !== live) return;
      const preview = text.length > 90 ? `${text.slice(0, 90)}…` : text;
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast.success("Clipboard received", { description: preview }))
        .catch(() =>
          toast.info("Clipboard received", {
            description: preview,
            duration: 10_000,
          }),
        );
    });

    const filesTick = window.setInterval(() => {
      if (rtcRef.current !== live) return;
      setFilesReady(live.filesReady());
      setClipReady(live.clipboardReady());
      setRecording(live.recording());
    }, 1000);

    return () => {
      offFile();
      offClip();
      window.clearInterval(filesTick);
      if (rtcRef.current === live) rtcRef.current = null;
      setRtcState("idle");
      setFilesReady(false);
      setClipReady(false);
      setRecording(false);
      live.close();
    };
  }, [liveId]);

  /** S22 — push the technician's local clipboard to the remote machine. */
  async function pushClipboard() {
    const live = rtcRef.current;
    if (!live?.clipboardReady()) {
      toast.error("Clipboard channel is not connected");
      return;
    }
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      toast.error("Clipboard blocked", {
        description: "Allow clipboard access for this site, then try again.",
      });
      return;
    }
    if (!text.trim()) {
      toast.info("Local clipboard is empty");
      return;
    }
    if (live.sendClipboard(text)) toast.success("Clipboard sent to the remote machine");
    else toast.error("Clipboard send failed");
  }

  /** S24 — start/stop a local WEBM recording of the live video track. */
  async function toggleRecording(sessionId: string) {
    const live = rtcRef.current;
    if (!live) return;
    if (live.recording()) {
      const result = await live.stopRecording();
      setRecording(false);
      if (!result) {
        toast.error("Recording produced no footage");
        return;
      }
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `connectlive-${sessionId.slice(0, 8)}-${Date.now()}.webm`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("Recording saved", {
        description: `${Math.round(result.durationMs / 1000)}s · ${(result.blob.size / 1048576).toFixed(1)} MB`,
      });
      return;
    }
    if (!live.canRecord()) {
      toast.error("Recording needs the live video stream", {
        description: "Wait for the WebRTC video to start, then record.",
      });
      return;
    }
    if (live.startRecording()) {
      setRecording(true);
      toast.success("Recording started");
    } else {
      toast.error("Recording could not start in this browser");
    }
  }


  // Mount the WebRTC <video> element into the live surface. The element is
  // owned by startWebRtcLive() and reused across re-renders; we only move it
  // in and out of the DOM here.
  useEffect(() => {
    const host = videoHostRef.current;
    const video = rtcRef.current?.video;
    if (!host || !video) return;
    if (video.parentElement !== host) host.appendChild(video);
    return () => {
      if (video.parentElement === host) host.removeChild(video);
    };
  }, [liveId, rtcVideoLive]);

  // Measure decoded video frame rate. requestVideoFrameCallback fires once per
  // presented frame, so this is the true stream cadence — the old HUD only ever
  // counted JPEG arrivals and therefore read "1 fps" during healthy video.
  useEffect(() => {
    if (!rtcVideoLive) {
      setVideoFps(0);
      setVideoDecoding(false);
      videoFpsRef.current = { last: 0, frames: 0, fps: 0 };
      return;
    }
    const video = rtcRef.current?.video as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
          cancelVideoFrameCallback?: (id: number) => void;
        })
      | undefined;
    if (!video) return;
    let stop = false;
    let handle = 0;
    const tick = () => {
      if (stop) return;
      const st = videoFpsRef.current;
      const t = performance.now();
      st.frames += 1;
      setVideoDecoding(true);
      if (!st.last) st.last = t;
      else if (t - st.last >= 1000) {
        st.fps = Math.round((st.frames * 1000) / (t - st.last));
        st.frames = 0;
        st.last = t;
        setVideoFps(st.fps);
      }
      if (video.requestVideoFrameCallback) handle = video.requestVideoFrameCallback(tick);
    };
    // Diagnostic: 3 s after the peer reports connected, say whether media is
    // actually arriving. No bytes = transport problem; bytes but no decoded
    // frames = codec/format problem on the sender.
    const probe = window.setTimeout(() => {
      void (async () => {
        try {
          const stats = await (rtcRef.current?.stats?.() ?? Promise.resolve(null));
          if (!stats) return;
          stats.forEach((r: Record<string, unknown>) => {
            if (r["type"] === "inbound-rtp" && r["kind"] === "video") {
              console.info(
                `[webrtc] inbound-rtp bytes=${r["bytesReceived"]} packets=${r["packetsReceived"]} framesDecoded=${r["framesDecoded"]}`,
              );
            }
          });
        } catch {
          /* diagnostics only */
        }
      })();
    }, 3000);
    if (video.requestVideoFrameCallback) {
      handle = video.requestVideoFrameCallback(tick);
    } else {
      // Safari/older engines: fall back to a decoded-frame-count poll.
      const iv = setInterval(() => {
        const q = (
          video as unknown as { getVideoPlaybackQuality?: () => { totalVideoFrames: number } }
        ).getVideoPlaybackQuality?.();
        if (!q) return;
        const st = videoFpsRef.current;
        if (q.totalVideoFrames > 0) setVideoDecoding(true);
        if (st.last) setVideoFps(Math.max(0, q.totalVideoFrames - st.frames));
        st.frames = q.totalVideoFrames;
        st.last = 1;
      }, 1000);
      return () => {
        clearInterval(iv);
        window.clearTimeout(probe);
      };
    }
    return () => {
      stop = true;
      window.clearTimeout(probe);
      if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    };
  }, [liveId, rtcVideoLive]);

  useEffect(() => {
    if (!liveId) return;
    const s = sessions.find((x) => x.id === liveId);
    if (s?.mode === "control") {
      requestAnimationFrame(() => liveSurfaceRef.current?.focus({ preventScroll: true }));
    }
  }, [liveId, sessions]);

  // Keep the live surface focused across tab switches, notification pop-ups,
  // and OSK re-renders — otherwise Enter/keys silently route to the browser
  // after long control sessions.
  useEffect(() => {
    if (!liveId) return;
    const s = sessions.find((x) => x.id === liveId);
    if (s?.mode !== "control") return;
    const restore = () => {
      if (document.visibilityState === "visible") {
        requestAnimationFrame(() => liveSurfaceRef.current?.focus({ preventScroll: true }));
      }
    };
    window.addEventListener("focus", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      window.removeEventListener("focus", restore);
      document.removeEventListener("visibilitychange", restore);
    };
  }, [liveId, sessions]);

  // Pointer-lock lifecycle: keep React state in sync with the DOM (Esc, focus
  // loss, or a stolen lock all release without firing our toggle handler). We
  // also refuse to hold the lock in view mode — mode flips must let the OS
  // cursor go immediately.
  useEffect(() => {
    const onChange = () => {
      const locked = document.pointerLockElement === liveSurfaceRef.current;
      setPointerLocked(locked);
      if (!locked) {
        pointerLockRelRef.current.dx = 0;
        pointerLockRelRef.current.dy = 0;
      }
    };
    document.addEventListener("pointerlockchange", onChange);
    return () => document.removeEventListener("pointerlockchange", onChange);
  }, []);
  useEffect(() => {
    if (!liveId) return;
    const s = sessions.find((x) => x.id === liveId);
    if (s?.mode !== "control" && document.pointerLockElement) document.exitPointerLock();
  }, [liveId, sessions]);

  async function refresh() {
    const [d, s, a] = await Promise.all([
      supabase.from("devices").select("*").order("last_seen_at", { ascending: false }),
      supabase.from("sessions").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    if (d.data) setDevices(d.data);
    if (s.data) setSessions(s.data);
    if (a.data) setAudit(a.data);
  }

  async function loadTg() {
    const { data } = await supabase.from("admin_settings").select("*").maybeSingle();
    if (data)
      setTg({
        telegram_bot_token: data.telegram_bot_token ?? "",
        telegram_chat_id: data.telegram_chat_id ?? "",
        notify_on_session_start: data.notify_on_session_start,
        notify_on_control_taken: data.notify_on_control_taken,
        notify_on_device_offline: data.notify_on_device_offline,
        notify_on_agent_stopped: (data as { notify_on_agent_stopped?: boolean }).notify_on_agent_stopped ?? true,
      });
  }

  async function saveTg() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase
      .from("admin_settings")
      .upsert({ user_id: u.user.id, ...tg, updated_at: new Date().toISOString() });
    setTgSaved("saved");
    setTimeout(() => setTgSaved(null), 2000);
  }

  async function testTg() {
    setTgSaved("testing");
    const r = await notify({
      data: {
        kind: "session_start",
        text: "✅ <b>ConnectLive</b> Telegram notifications are working.",
      },
    });
    setTgSaved(r.ok ? "test_ok" : "test_fail");
    setTimeout(() => setTgSaved(null), 3000);
  }

  const presenceOf = (d: Device): "online" | "reconnecting" | "offline" | "stopped" => {
    // "stopped" is a hard state set by the watch-app beacon — a user killed
    // ConnectLive.exe in Task Manager. It stays until the next heartbeat
    // (via auto-relaunch) flips the row back to online.
    if (d.status === "stopped") return "stopped";
    const last = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
    const age = now - last;
    if (d.status === "online" && age < STALE_MS) return "online";
    if (age < OFFLINE_MS) return "reconnecting";
    return "offline";
  };

  // Single funnel for Telegram pushes so delivery problems (muted toggle,
  // missing bot token, Telegram API errors) are visible in the console
  // instead of silently swallowed by a floating promise.
  async function pushNotify(
    kind: "session_start" | "session_end" | "control_taken" | "control_released" | "device_offline" | "agent_stopped",
    text: string,
  ) {
    try {
      const r = await notify({ data: { kind, text } });
      if (!r?.ok)
        console.warn(
          `[telegram:${kind}] not delivered —`,
          (r as { reason?: string })?.reason ?? "unknown reason",
        );
      return r;
    } catch (e) {
      console.warn(`[telegram:${kind}] request failed —`, e);
      return { ok: false as const, reason: "request_failed" };
    }
  }

  // device_offline: fire once per online → offline transition. A ref keeps the
  // last presence per device so the 5s refresh loop can't spam the channel.
  const prevPresenceRef = useRef<Map<string, "online" | "reconnecting" | "offline" | "stopped">>(new Map());
  useEffect(() => {
    const prev = prevPresenceRef.current;
    for (const d of devices) {
      const p = presenceOf(d);
      const was = prev.get(d.id);
      prev.set(d.id, p);
      if (!was) continue;
      if (was !== "stopped" && p === "stopped") {
        void pushNotify(
          "agent_stopped",
          `🛑 Agent process was terminated on <b>${d.display_name ?? "Device"}</b> (${d.hostname ?? d.device_id}). It will relaunch within ~60s.`,
        );
      } else if (was !== "offline" && was !== "stopped" && p === "offline") {
        void pushNotify(
          "device_offline",
          `🔌 <b>${d.display_name ?? "Device"}</b> is unreachable (last seen ${d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}).`,
        );
      }
    }
    for (const id of [...prev.keys()]) if (!devices.some((d) => d.id === id)) prev.delete(id);
  }, [devices, now]);

  // Open a session on a specific enrolled device. The agent picks it up
  // via /heartbeat within ~5s (no PIN, no user prompt) and starts streaming
  // immediately — the standalone agent has no local consent dialog.
  async function connectDevice(d: Device) {
    const { data: u } = await supabase.auth.getUser();
    // Reuse the newest live session for this device instead of stacking a
    // fresh invite each click. Stacked invites are the black-screen bug:
    // the agent's session loop settles on the OLDEST id and pushes frames
    // to a session no one is polling.
    const { data: existingRows } = await supabase
      .from("sessions")
      .select("id, created_at")
      .eq("device_id", d.id)
      .in("state", ["invited", "consented", "active", "paused"])
      .order("created_at", { ascending: false })
      .limit(1);
    const existing = existingRows?.[0];
    if (existing) {
      setLiveId(existing.id);
      return;
    }
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        technician_id: u.user?.id,
        mode: "view",
        state: "invited",
        device_id: d.id,
      })
      .select()
      .single();
    if (error) return alert(error.message);
    if (data) setLiveId(data.id);
  }

  async function endSession(s: Session) {
    await sendInput(s.id, "release_inputs", {});
    await sendInput(s.id, "curtain_off", {});
    await supabase
      .from("sessions")
      .update({ state: "ended", ended_at: new Date().toISOString(), pairing_code: null })
      .eq("id", s.id);
    const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
    void pushNotify("session_end", `⏹️ Session ended on <b>${dev?.display_name ?? "device"}</b>`);
  }

  async function deleteSession(s: Session) {
    if (!confirm("Delete this session permanently?")) return;
    const { error } = await supabase.from("sessions").delete().eq("id", s.id);
    if (error) alert(error.message);
  }

  type PowerKind = "wake" | "reboot" | "shutdown" | "lock" | "logoff";
  async function queuePower(d: Device, kind: PowerKind) {
    const labels: Record<PowerKind, string> = {
      wake: "Send Wake-on-LAN magic packet",
      reboot: "Reboot the remote machine in 5 seconds",
      shutdown: "Shut down the remote machine in 5 seconds",
      lock: "Lock the remote workstation",
      logoff: "Sign out the current user",
    };
    if (kind === "reboot" || kind === "shutdown") {
      if (!confirm(`${labels[kind]} on ${d.display_name}?`)) return;
    }
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      alert("Not signed in");
      return;
    }

    let relayId: string | null = null;
    let mac: string | null = null;
    if (kind === "wake") {
      // Staged reporting so the operator knows exactly why a wake can or can't route.
      if (presenceOf(d) === "online") {
        alert("This device is already online — use Connect instead.");
        return;
      }
      const meta = (d.metadata ?? {}) as Record<string, unknown>;
      mac = (meta.mac as string | undefined) ?? null;
      const subnet = (meta.lan_subnet_v4 as string | undefined) ?? null;
      if (!subnet) {
        alert(
          "This device has never reported a LAN subnet, so Wake-on-LAN can't be routed. It must check in once while online first.",
        );
        return;
      }
      if (!mac) {
        alert(
          `Subnet ${subnet} is known but no MAC address has been recorded yet — WoL needs both. Let the agent check in once more while online.`,
        );
        return;
      }
      const peer = devices.find(
        (p) =>
          p.id !== d.id &&
          presenceOf(p) === "online" &&
          ((p.metadata ?? {}) as Record<string, unknown>).lan_subnet_v4 === subnet,
      );
      if (!peer) {
        alert(
          `Powered-off wake needs another ConnectLive machine online on ${subnet} to broadcast the magic packet. None is online right now.`,
        );
        return;
      }
      relayId = peer.id;
    }

    const { error } = await supabase.from("power_commands").insert({
      device_id: d.id,
      relay_device_id: relayId,
      kind,
      payload: kind === "wake" ? ({ mac } as never) : ({} as never),
      requested_by: u.user.id,
    });
    if (error) {
      alert(`Queue failed: ${error.message}`);
      return;
    }
    const via = relayId ? ` (via ${devices.find((p) => p.id === relayId)?.display_name})` : "";
    void pushNotify(
      "control_taken",
      `⚡ ${labels[kind]} queued for <b>${d.display_name}</b>${via}`,
    );
  }

  async function toggleControl(s: Session) {
    const nextMode = s.mode === "control" ? "view" : "control";
    await supabase.from("sessions").update({ mode: nextMode }).eq("id", s.id);
    // Fire the curtain command through the same input relay the agent already polls.
    // curtain_on doubles as the watchdog heartbeat on the agent — if these stop
    // arriving for >5s, the agent auto-releases BlockInput.
    await supabase.from("session_inputs").insert({
      session_id: s.id,
      kind: nextMode === "control" ? "curtain_on" : "curtain_off",
      payload: {} as never,
    });
    const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
    void pushNotify(
      nextMode === "control" ? "control_taken" : "control_released",
      nextMode === "control"
        ? `🎮 Curtain engaged on <b>${dev?.display_name ?? "device"}</b>`
        : `👤 Curtain released on <b>${dev?.display_name ?? "device"}</b>`,
    );
  }

  async function requestReconnect(s: Session) {
    if (!s.device_id) return;
    await sendInput(s.id, "curtain_off", {});
    const { error } = await supabase
      .from("sessions")
      .update({ state: "active", mode: "view", updated_at: new Date().toISOString() })
      .eq("id", s.id);
    if (error) return alert(error.message);
    // Explicit wake: the SYSTEM updater picks this up on its next heartbeat
    // and relaunches the agent even if the user closed it manually.
    const wakeQueued = await queueWakeAgent(s.device_id, s.id);
    if (!wakeQueued) return;
    setLiveId(s.id);
    const dev = devices.find((d) => d.id === s.device_id);
    void pushNotify(
      "session_start",
      `🔁 Wake sent — waiting for <b>${dev?.display_name ?? "device"}</b> to reconnect to the existing session.`,
    );
    void refresh();
  }

  // Queue a `wake_agent` power command so the SYSTEM updater respawns the
  // agent in the interactive desktop session. Best-effort: a failure here
  // never blocks the session flow.
  async function queueWakeAgent(deviceRowId: string, sessionId?: string) {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return false;
    const { error } = await supabase.from("power_commands").insert({
      device_id: deviceRowId,
      kind: "wake_agent",
      payload: (sessionId ? { session_id: sessionId } : {}) as never,
      state: "queued",
      requested_by: auth.user.id,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (error) {
      alert(`Reconnect could not be queued: ${error.message}`);
      return false;
    }
    return true;
  }

  // Enqueue a mouse/keyboard event for the agent to replay via SendInput.
  // Coordinates are normalized (0..1) relative to the rendered surface.
  async function sendInput(sessionId: string, kind: string, payload: Record<string, unknown>) {
    // Continuous mouse streams stay RTC-only to avoid flooding the DB.
    // The curtain dead-man ping is also RTC-first: at 1s cadence against the
    // agent's 5s watchdog it has 5x margin on either transport, so there is no
    // reason to write a DB row every second when the data channel is open.
    // Discrete "one-shot" events (clicks, keys, text) go BOTH via RTC and DB
    // so an unhealthy data channel can never silently drop a keystroke.
    const continuous =
      kind === "mousemove" || kind === "mousemove_rel" || kind === "wheel" || kind === "curtain_on";
    const sentRealtime = rtcRef.current?.sendInput({ kind, payload }) ?? false;
    if (continuous && sentRealtime) return;
    await supabase
      .from("session_inputs")
      .insert({ session_id: sessionId, kind, payload: payload as never });
  }

  // Pointer moves are coalesced to one flush per animation frame (~16ms), and
  // only the newest position survives — stale intermediate points add latency
  // without adding information. Buttons/keys/wheel bypass this and stay ordered.
  function queueMove(sessionId: string, kind: string, payload: Record<string, unknown>) {
    pendingMoveRef.current = { sessionId, kind, payload };
    if (moveRafRef.current !== null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const m = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (m) void sendInput(m.sessionId, m.kind, m.payload);
    });
  }

  // Pointer-lock relative moves: accumulate every `movementX/Y` sample and
  // ship the summed delta once per frame. Zero-delta frames are dropped.
  function queueRelMove(sessionId: string, dx: number, dy: number) {
    pointerLockRelRef.current.dx += dx;
    pointerLockRelRef.current.dy += dy;
    if (moveRafRef.current !== null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const acc = pointerLockRelRef.current;
      const dxOut = Math.round(acc.dx);
      const dyOut = Math.round(acc.dy);
      acc.dx -= dxOut;
      acc.dy -= dyOut;
      if (dxOut !== 0 || dyOut !== 0)
        void sendInput(sessionId, "mousemove_rel", { dx: dxOut, dy: dyOut });
    });
  }

  // Flush any queued move before an ordered event so a click never lands ahead
  // of the move that positioned it.
  function flushMoveNow(sessionId?: string) {
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    const m = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (m) void sendInput(m.sessionId, m.kind, m.payload);
    // Drain the pointer-lock accumulator too, otherwise a click can land
    // before the delta that aimed it.
    const acc = pointerLockRelRef.current;
    const dxOut = Math.round(acc.dx);
    const dyOut = Math.round(acc.dy);
    acc.dx -= dxOut;
    acc.dy -= dyOut;
    if (sessionId && (dxOut !== 0 || dyOut !== 0))
      void sendInput(sessionId, "mousemove_rel", { dx: dxOut, dy: dyOut });
  }

  // Natural size of whichever layer is currently visible. WebRTC video and the
  // JPEG fallback are letterboxed identically (object-contain), so only the
  // source dimensions differ between the two. Returns null while the size is
  // still unknown — callers then hold the input rather than guess.
  function activeSourceSize(): { width: number; height: number } | null {
    if (videoDecodingRef.current) {
      const v = rtcRef.current?.video;
      if (v && v.videoWidth > 0 && v.videoHeight > 0)
        return { width: v.videoWidth, height: v.videoHeight };
      return null;
    }
    if (liveFrame?.width && liveFrame?.height)
      return { width: liveFrame.width, height: liveFrame.height };
    return null;
  }

  function focusLiveSurface() {
    requestAnimationFrame(() => liveSurfaceRef.current?.focus({ preventScroll: true }));
  }

  function sendKeyboardDown(
    sessionId: string,
    e: React.KeyboardEvent<HTMLElement>,
    updateEcho = false,
  ) {
    if (e.nativeEvent.isComposing) return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable) {
      e.preventDefault();
      void sendInput(sessionId, "unicode_text", { text: e.key });
      if (updateEcho) setSharedNote((v) => (v + e.key).slice(-240));
      return;
    }

    const vk = keyToVirtualKey(e);
    if (!vk) return;
    e.preventDefault();
    if (updateEcho && e.key === "Backspace") setSharedNote((v) => v.slice(0, -1));
    void sendInput(sessionId, "keydown", { vk });
  }

  function sendKeyboardUp(sessionId: string, e: React.KeyboardEvent<HTMLElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    const vk = keyToVirtualKey(e);
    if (!vk) return;
    e.preventDefault();
    void sendInput(sessionId, "keyup", { vk });
  }

  function pasteToRemote(sessionId: string, e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    void sendInput(sessionId, "unicode_text", { text });
    setSharedNote((v) => (v + text).slice(-240));
  }

  // Dead-man's switch on the admin side: while we hold a control session open,
  // ping curtain_on every 1s. If this tab closes, crashes, or the network drops,
  // the agent's watchdog releases BlockInput within ~5s.
  useEffect(() => {
    if (!liveId) return;
    const s = sessions.find((x) => x.id === liveId);
    if (!s || s.mode !== "control" || !s.device_id) return;
    const ping = () => {
      void sendInput(s.id, "curtain_on", {});
    };
    ping();
    const t = setInterval(ping, 1000);
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        void sendInput(s.id, "curtain_off", {});
      } else {
        ping();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onHide);
      // Best-effort release when the live view closes or session mode changes.
      void sendInput(s.id, "curtain_off", {});
    };
  }, [liveId, sessions]);

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  const selectedDevices = useMemo(
    () => devices.filter((d) => selected.has(d.id)),
    [devices, selected],
  );

  async function bulkEndSessions() {
    if (selectedDevices.length === 0) return;
    if (!confirm(`End all active sessions on ${selectedDevices.length} device(s)?`)) return;
    const ids = selectedDevices.map((d) => d.id);
    const { data: open } = await supabase
      .from("sessions")
      .select("id, device_id")
      .in("device_id", ids)
      .in("state", ["active", "paused", "invited"]);
    if (open && open.length) {
      await supabase
        .from("sessions")
        .update({ state: "ended", ended_at: new Date().toISOString() })
        .in(
          "id",
          open.map((x) => x.id),
        );
    }
    setSelected(new Set());
  }

  async function bulkRestartAgent() {
    if (selectedDevices.length === 0) return;
    if (!confirm(`Soft-restart ${selectedDevices.length} agent(s)?`)) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const rows = selectedDevices.map((d) => ({
      device_id: d.id,
      kind: "restart_agent",
      payload: {} as never,
      state: "queued",
      requested_by: auth.user.id,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    }));
    const { error } = await supabase.from("power_commands").insert(rows);
    if (error) alert(`Restart agent failed: ${error.message}`);
    setSelected(new Set());
  }

  // Queue a restart_stream power command for the session's device. The agent
  // rebuilds its WebRTC peer + capture pipeline without exiting the process.
  async function restartStream(s: Session) {
    if (!s.device_id) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const { error } = await supabase.from("power_commands").insert({
      device_id: s.device_id,
      kind: "restart_stream",
      payload: {} as never,
      state: "queued",
      requested_by: auth.user.id,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (error) return alert(`Restart stream failed: ${error.message}`);
  }

  // SCOPE:CAPTURE — browser twin of the native admin picker. Enqueue
  // switch_monitor, then restart_stream: a display change invalidates every
  // buffered frame and the encoder's reference chain, so a fresh stream beats
  // torn pixels at the previous display's resolution.
  async function switchMonitor(s: Session, m: MonitorEntry) {
    if (!s.device_id) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const { error } = await supabase.from("power_commands").insert({
      device_id: s.device_id,
      kind: "switch_monitor",
      payload: { device_name: m.device_name, index: m.index } as never,
      state: "queued",
      requested_by: auth.user.id,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (error) return alert(`Switch display failed: ${error.message}`);
    setLiveFrame(null);
    setLiveCursor(null);
    await restartStream(s);
  }



  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/connectlive/admin" });
  }

  const reconnecting = devices.filter((d) => presenceOf(d) === "reconnecting");
  const onlineCount = devices.filter((d) => presenceOf(d) === "online").length;
  const activeSessions = sessions.filter((s) => s.state === "active" || s.state === "paused");
  const pendingSessions = sessions.filter((s) => s.state === "invited");

  const NavBtn = ({ id, label, badge }: { id: Nav; label: string; badge?: number }) => (
    <button
      onClick={() => setNav(id)}
      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
        nav === id
          ? "bg-[#4F7CFF]/20 text-white"
          : "text-white/60 hover:bg-white/5 hover:text-white"
      }`}
    >
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-[#4F7CFF] px-1.5 py-0.5 text-[10px] font-medium text-white">
          {badge}
        </span>
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-[#0B1220] text-white">
      <div className="flex min-h-screen">
        {/* Sidebar (desktop) */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-white/10 bg-[#0F172A] p-4 lg:flex">
          <div className="mb-6 flex items-center gap-2 px-2">
            <span className="inline-block h-3 w-3 rounded-full bg-[#4F7CFF]" />
            <span className="font-semibold">ConnectLive</span>
          </div>
          <nav className="flex-1 space-y-1">
            <NavBtn id="dashboard" label="Dashboard" />
            <NavBtn id="devices" label="Devices" badge={onlineCount} />
            <NavBtn id="expected" label="Expected devices" />
            <NavBtn id="sessions" label="Sessions" badge={activeSessions.length} />
            <NavBtn id="audit" label="Audit log" />
            {role === "super_admin" && <NavBtn id="team" label="Team" />}
            {role === "super_admin" && <NavBtn id="settings" label="Settings" />}
          </nav>
          <div className="mt-4 border-t border-white/10 pt-4 text-xs text-white/50">
            <div className="truncate">{userEmail}</div>
            {role && (
              <div className="mt-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[#B9CCFF]">
                {role.replace("_", " ")}
              </div>
            )}
            <button
              onClick={signOut}
              className="mt-2 w-full rounded border border-white/15 px-2 py-1 hover:bg-white/5"
            >
              Sign out
            </button>
          </div>
        </aside>

        {/* Main */}
        <div className="min-w-0 flex-1">
          <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-white/10 px-4 py-3 sm:px-6 sm:py-4">
            <h1 className="truncate text-base font-semibold capitalize sm:text-lg">{nav}</h1>
            <div className="flex shrink-0 items-center gap-3">
              <NotificationBell userId={userId} />
              {role !== "viewer" && (
                <span className="hidden text-xs text-white/50 xl:inline">
                  Devices auto-enroll — click <b>Connect</b> on any online device.
                </span>
              )}
              <button
                onClick={signOut}
                className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5 lg:hidden"
              >
                Sign out
              </button>
            </div>
          </header>

          {/* Nav strip (tablet + mobile) */}
          <div className="flex gap-1.5 overflow-x-auto border-b border-white/10 px-3 py-2 lg:hidden">
            {(
              [
                ["dashboard", "Dashboard"],
                ["devices", "Devices"],
                ["expected", "Expected"],
                ["sessions", "Sessions"],
                ["audit", "Audit"],
                ...(role === "super_admin"
                  ? ([
                      ["team", "Team"],
                      ["settings", "Settings"],
                    ] as const)
                  : []),
              ] as ReadonlyArray<readonly [Nav, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setNav(id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs transition ${
                  nav === id
                    ? "bg-[#4F7CFF]/20 text-white"
                    : "text-white/60 hover:bg-white/5 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {reconnecting.length > 0 && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200 sm:px-6">
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              {reconnecting.length} device{reconnecting.length > 1 ? "s" : ""} reconnecting…
            </div>
          )}

          <main className="p-4 sm:p-6">

            {nav === "dashboard" && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                  <StatCard label="Online devices" value={onlineCount} tone="blue" />
                  <StatCard label="Active sessions" value={activeSessions.length} tone="green" />
                  <StatCard label="Pending invites" value={pendingSessions.length} tone="amber" />
                  <StatCard label="Total devices" value={devices.length} tone="slate" />
                </div>

                {pendingSessions.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">
                      Pending invites
                    </h2>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {pendingSessions.map((s) => {
                        const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
                        return (
                          <div
                            key={s.id}
                            className="rounded-lg border border-white/10 bg-[#1F2A44] p-4"
                          >
                            <div className="text-xs text-white/50">Device</div>
                            <div className="my-1 truncate text-base font-medium">
                              {dev?.display_name ?? "unknown"}
                            </div>
                            <div className="mb-2 text-xs text-white/40">
                              Invited {new Date(s.created_at).toLocaleTimeString()}
                            </div>
                            <button
                              onClick={() => deleteSession(s)}
                              className="rounded bg-red-500/70 px-2 py-1 text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                <section>
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/60">
                    Recent events
                  </h2>
                  <div className="rounded-lg border border-white/10 bg-[#1F2A44] p-4 text-xs">
                    {audit.slice(0, 10).map((a) => (
                      <div
                        key={a.id}
                        className="border-b border-white/5 py-1 font-mono last:border-0"
                      >
                        <span className="text-white/40">
                          {new Date(a.created_at).toLocaleTimeString()}
                        </span>{" "}
                        <span className="text-[#4F7CFF]">{a.event}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {nav === "devices" && (
              <DevicesTable
                devices={devices}
                presenceOf={presenceOf}
                selected={selected}
                toggleSelect={toggleSelect}
                onBulkEnd={bulkEndSessions}
                onBulkRestart={bulkRestartAgent}
                onClearSelected={() => setSelected(new Set())}
                onConnect={connectDevice}
                canConnect={role !== "viewer"}
                canDelete={role === "super_admin" || role === "admin"}
                canPower={role === "super_admin" || role === "admin" || role === "technician"}
                canShutdown={role === "super_admin" || role === "admin"}
                onWake={(d) => queuePower(d, "wake")}
                onPower={(d, kind) => queuePower(d, kind)}
                onDelete={async (d) => {
                  if (
                    !confirm(
                      `Remove ${d.display_name} from the device list? The agent will need to re-enroll to reconnect.`,
                    )
                  )
                    return;
                  const { error } = await supabase.from("devices").delete().eq("id", d.id);
                  if (error) {
                    alert(`Delete failed: ${error.message}`);
                    return;
                  }
                  setDevices((prev) => prev.filter((x) => x.id !== d.id));
                  setSelected((prev) => {
                    const n = new Set(prev);
                    n.delete(d.id);
                    return n;
                  });
                }}
              />
            )}

            {nav === "expected" && <ExpectedDevicesPanel />}

            {nav === "sessions" && (
              <SessionsTable
                sessions={sessions}
                devices={devices}
                onLive={(s) => setLiveId(s.id)}
                onToggleControl={toggleControl}
                onReconnect={requestReconnect}
                onEnd={endSession}
                onDelete={deleteSession}
                presenceOf={presenceOf}
              />
            )}

            {nav === "audit" && (
              <div className="space-y-4">
                <ReaperPanel audit={audit} devices={devices} />
                <RenderHealthPanel />
                <div className="rounded-lg border border-white/10 bg-[#1F2A44] p-4 text-xs">
                  {audit.length === 0 ? (
                    <p className="text-white/40">No events yet.</p>
                  ) : (
                    <ul className="space-y-1 font-mono">
                      {audit.map((a) => (
                        <li key={a.id} className="border-b border-white/5 py-1 last:border-0">
                          <span className="text-white/40">
                            {new Date(a.created_at).toLocaleString()}
                          </span>{" "}
                          <span
                            className={
                              a.event === "session.reaped" ? "text-[#F5A524]" : "text-[#4F7CFF]"
                            }
                          >
                            {a.event}
                          </span>{" "}
                          <span className="text-white/50">{JSON.stringify(a.detail)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {nav === "settings" && role === "super_admin" && (
              <TelegramSettings
                tg={tg}
                setTg={setTg}
                onSave={saveTg}
                onTest={testTg}
                status={tgSaved}
              />
            )}

            {nav === "team" && role === "super_admin" && <TeamPanel />}

          </main>
        </div>
      </div>

      {/* Live view modal */}
      {liveId &&
        (() => {
          const s = sessions.find((x) => x.id === liveId);
          if (!s) return null;
          const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
          const presence = dev ? presenceOf(dev) : null;
          const active = s.state === "active";
          const frameAge = liveFrame?.updated_at
            ? now - new Date(liveFrame.updated_at).getTime()
            : Infinity;
          // Grace window after the video track drops: the JPEG fallback has to
          // resubscribe and wait for the agent's next push, so a stale frame in
          // that window means "handing over", not "dead".
          const sinceRtcDrop = rtcDroppedAtRef.current ? now - rtcDroppedAtRef.current : Infinity;
          const handingOver = !videoDecoding && sinceRtcDrop < 8000;
          const streamState = !active
            ? "paused"
            : videoDecoding
              ? "live"
              : presence && presence !== "online"
                ? "reconnecting"
                : handingOver
                  ? "reconnecting"
                  : !liveFrame?.frame
                    ? "waiting"
                    : frameAge < 2000
                      ? "live"
                      : frameAge < 8000
                        ? "lag"
                        : "stalled";
          const streamTone =
            streamState === "live"
              ? "bg-emerald-400"
              : streamState === "lag" || streamState === "waiting" || streamState === "reconnecting"
                ? "bg-amber-400"
                : "bg-rose-500";
          const streamCopy = {
            live: "Live",
            lag: "Lagging",
            stalled: "Stalled",
            waiting: "Waiting for first frame",
            reconnecting: "Device reconnecting",
            paused: "Session paused",
          }[streamState];
          const rtSinceLastPush = lastRealtimePushAtRef.current
            ? now - lastRealtimePushAtRef.current
            : Infinity;
          // Transport pill: only a decoded frame earns the "WebRTC video" label.
          // A peer that completed ICE but never delivers pixels reads
          // "WebRTC negotiating" so this exact failure is visible at a glance.
          const transport:
            | "connecting"
            | "video"
            | "negotiating"
            | "live"
            | "reconnecting"
            | "polling" = videoDecoding
            ? "video"
            : rtcVideoLive
              ? "negotiating"
              : rtcState === "connecting" || handingOver
                ? "connecting"
                : realtimeStatus === "reconnecting" || realtimeStatus === "closed"
                  ? "reconnecting"
                  : realtimeStatus === "connecting"
                    ? "connecting"
                    : rtSinceLastPush < 5000
                      ? "live"
                      : "polling";
          const transportTone =
            transport === "video"
              ? "bg-emerald-400"
              : transport === "reconnecting"
                ? "bg-rose-500"
                : "bg-amber-400";
          // Candidate type turns the LAN-vs-cross-network test into a direct
          // read: host = LAN, srflx = NAT-traversed direct path.
          const iceKind = rtcRef.current?.candidateType?.() ?? null;
          // S16 — a deployment with no TURN relay cannot traverse symmetric NAT,
          // so the session sits on JPEG frames forever. Name it in the pill
          // instead of leaving "Frame fallback" looking like an agent problem.
          const relay = rtcRef.current?.relay?.() ?? "pending";
          const noRelay = relay === "none" && !videoDecoding;
          const videoLabel = `WebRTC video${iceKind ? ` · ${iceKind}` : ""}${videoFps ? ` · ${videoFps} fps` : ""}`;
          const transportLabel = {
            connecting: "Connecting",
            video: videoLabel,
            negotiating: `WebRTC negotiating${iceKind ? ` · ${iceKind}` : ""} · no frames yet`,
            live: `Frame fallback (${fpsCounterRef.current.fps} fps)${noRelay ? " · no relay" : ""}`,
            reconnecting: "Reconnecting",
            polling: `Frame fallback (polling)${noRelay ? " · no relay" : ""}`,
          }[transport];


          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
              onClick={() => setLiveId(null)}
            >
              <div
                className="w-full max-w-[min(96vw,1760px)] overflow-hidden rounded-xl border border-white/10 bg-[#0F172A] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[#4F7CFF] animate-pulse" : "bg-amber-400"}`}
                    />
                    <div>
                      <div className="text-sm font-semibold">
                        {dev?.display_name ?? "Waiting for agent…"}
                      </div>
                      <div className="text-xs text-white/50">
                        {s.mode === "control" ? "Remote control" : "View only"} · {s.state} ·{" "}
                        {streamCopy}
                      </div>
                    </div>
                    <span
                      title={`WebRTC: ${rtcState}. ICE relay: ${relay === "relay" ? "TURN available" : relay === "none" ? "none — direct paths only, symmetric NAT will fail" : "resolving"}. Realtime socket: ${realtimeStatus}. Last frame push ${Number.isFinite(rtSinceLastPush) ? `${Math.round(rtSinceLastPush)}ms ago` : "never"}.`}
                      className="ml-2 flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/80"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${transportTone} ${transport === "video" ? "animate-pulse" : ""}`}
                      />
                      {transportLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.device_id && role !== "viewer" && (
                      <MonitorPicker
                        device={dev}
                        onSelect={(m) => void switchMonitor(s, m)}
                      />
                    )}
                    {s.device_id && role !== "viewer" && (

                      <button
                        onClick={() => {
                          setLiveFrame(null);
                          setLiveCursor(null);
                          void restartStream(s);
                          void requestReconnect(s);
                        }}
                        className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                        title="Ask the agent to rebuild its capture + WebRTC pipeline for this session"
                      >
                        Restart stream
                      </button>
                    )}
                    {s.device_id && role !== "viewer" && (
                      <button
                        onClick={() => toggleControl(s)}
                        className={`rounded px-3 py-1.5 text-xs font-medium ${s.mode === "control" ? "bg-red-500/90 hover:bg-red-500 text-white" : "bg-white/10 hover:bg-white/15"}`}
                        title={
                          s.mode === "control"
                            ? "Release curtain and return control to the user"
                            : "Block the user's keyboard/mouse and take control"
                        }
                      >
                        {s.mode === "control" ? "🔓 Release curtain" : "🔒 Curtain (take control)"}
                      </button>
                    )}
                    {s.device_id && s.mode === "control" && role !== "viewer" && (
                      <button
                        onClick={() => {
                          const el = liveSurfaceRef.current;
                          if (!el) return;
                          if (pointerLocked && document.pointerLockElement) {
                            document.exitPointerLock();
                          } else {
                            focusLiveSurface();
                            el.requestPointerLock?.();
                          }
                        }}
                        className={`rounded px-3 py-1.5 text-xs font-medium ${pointerLocked ? "bg-emerald-500/90 text-white hover:bg-emerald-500" : "bg-white/10 hover:bg-white/15"}`}
                        title={
                          pointerLocked
                            ? "Release pointer capture (Esc)"
                            : "Capture pointer — send raw mouse deltas for a native feel"
                        }
                      >
                        {pointerLocked ? "🎯 Pointer locked" : "🎯 Capture pointer"}
                      </button>
                    )}
                    {role !== "viewer" && (
                      <button
                        onClick={() => {
                          endSession(s);
                          setLiveId(null);
                        }}
                        className="rounded bg-red-500/80 px-3 py-1.5 text-xs"
                      >
                        End
                      </button>
                    )}
                    <button
                      onClick={() => setLiveId(null)}
                      className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div className="relative aspect-video bg-black">
                  {!s.device_id ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
                      Session has no device attached.
                    </div>
                  ) : videoDecoding || liveFrame?.frame ? (
                    <div
                      ref={liveSurfaceRef}
                      tabIndex={s.mode === "control" ? 0 : -1}
                      className={`absolute inset-0 outline-none ${s.mode === "control" ? "cursor-crosshair" : ""}`}
                      onMouseMove={
                        s.mode === "control"
                          ? (e) => {
                              if (pointerLocked && document.pointerLockElement === e.currentTarget) {
                                queueRelMove(s.id, e.movementX, e.movementY);
                                return;
                              }
                              const point = getContainedPoint(
                                e.currentTarget,
                                e.clientX,
                                e.clientY,
                                activeSourceSize(),
                              );
                              if (!point) return;
                              queueMove(s.id, "mousemove", point);
                            }
                          : undefined
                      }
                      onMouseDown={
                        s.mode === "control"
                          ? (e) => {
                              e.preventDefault();
                              focusLiveSurface();
                              mouseButtonDownRef.current = true;
                              flushMoveNow(s.id);
                              if (!(pointerLocked && document.pointerLockElement === e.currentTarget)) {
                                const point = getContainedPoint(
                                  e.currentTarget,
                                  e.clientX,
                                  e.clientY,
                                  activeSourceSize(),
                                );
                                if (point) void sendInput(s.id, "mousemove", point);
                              }
                              void sendInput(s.id, "mousedown", { button: e.button });
                            }
                          : undefined
                      }
                      onMouseUp={
                        s.mode === "control"
                          ? (e) => {
                              e.preventDefault();
                              mouseButtonDownRef.current = false;
                              flushMoveNow(s.id);
                              void sendInput(s.id, "mouseup", { button: e.button });
                            }
                          : undefined
                      }
                      onMouseLeave={
                        s.mode === "control"
                          ? () => {
                              mouseButtonDownRef.current = false;
                            }
                          : undefined
                      }
                      onContextMenu={s.mode === "control" ? (e) => e.preventDefault() : undefined}
                      onWheel={
                        s.mode === "control"
                          ? (e) => {
                              e.preventDefault();
                              void sendInput(s.id, "wheel", { dy: e.deltaY });
                            }
                          : undefined
                      }
                      onKeyDown={
                        s.mode === "control" ? (e) => sendKeyboardDown(s.id, e) : undefined
                      }
                      onKeyUp={s.mode === "control" ? (e) => sendKeyboardUp(s.id, e) : undefined}
                    >
                      {/* Primary layer: the WebRTC video track (hardware-decoded,
                        real frame rate). The element itself is created and owned
                        by startWebRtcLive(); we only host it here. */}
                      <div
                        ref={videoHostRef}
                        className={`pointer-events-none absolute inset-0 ${videoDecoding ? "" : "hidden"}`}
                      />
                      {/* Fallback layer: base64 JPEG slideshow from session_frames.
                        Same object-contain letterboxing so coordinate mapping is
                        identical apart from the source dimensions. */}
                      {!videoDecoding && liveFrame?.frame && (
                        <img
                          src={`data:image/jpeg;base64,${liveFrame.frame}`}
                          alt="Live screen"
                          className="pointer-events-none absolute inset-0 h-full w-full object-contain [image-rendering:auto]"
                          draggable={false}
                          decoding="async"
                        />
                      )}
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
                      <div className="flex items-center gap-2 rounded-full border border-[#4F7CFF]/30 bg-[#4F7CFF]/10 px-3 py-1 text-xs text-[#B9CCFF]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#4F7CFF] animate-pulse" />
                        {streamCopy}
                      </div>
                      <div className="text-sm text-white/60">
                        {presence && presence !== "online"
                          ? "The device heartbeat is reconnecting; the stream will resume when the agent checks in."
                          : active
                            ? "The agent is active; waiting for its screen uploader to send a fresh frame."
                            : "Open or restart the session to resume streaming."}
                      </div>
                    </div>
                  )}
                  {s.device_id &&
                    (videoDecoding || liveFrame?.frame) &&
                    liveCursor &&
                    liveCursor.visible && (
                      <RemoteCursorOverlay cursor={liveCursor} frame={liveFrame} />
                    )}
                  <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded bg-black/60 px-2 py-1 font-mono text-[10px] text-white/70">
                    {(() => {
                      // Stream health: green <2s, amber <8s, red otherwise. Gives the
                      // admin an at-a-glance signal that the frame pipe is healthy
                      // (or lagging) without cluttering the viewport.
                      return (
                        <span className="flex items-center gap-1">
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${streamTone}`} />
                          <span>{streamState}</span>
                        </span>
                      );
                    })()}
                    <span>
                      session {s.id.slice(0, 8)}
                      {s.device_id ? ` · device ${s.device_id.slice(0, 8)}` : ""}
                    </span>
                    <span>
                      ·{" "}
                      {videoDecoding
                        ? `${videoFps} fps video`
                        : `${fpsCounterRef.current.fps} fps frames`}
                    </span>
                    {!videoDecoding && liveFrame?.updated_at && (
                      <span>· {new Date(liveFrame.updated_at).toLocaleTimeString()}</span>
                    )}
                    {/* S21 — transfer path at a glance: direct datachannel vs
                        the archive/HTTP fallback. */}
                    <span className="flex items-center gap-1">
                      ·
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          filesReady ? "bg-emerald-400" : "bg-white/30"
                        }`}
                      />
                      <span>{filesReady ? "files direct" : "files via archive"}</span>
                    </span>
                    {/* S22 — clipboard channel state. */}
                    <span className="flex items-center gap-1">
                      ·
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          clipReady ? "bg-emerald-400" : "bg-white/30"
                        }`}
                      />
                      <span>{clipReady ? "clipboard synced" : "clipboard offline"}</span>
                    </span>
                    {recording && (
                      <span className="flex items-center gap-1 text-red-300">
                        ·
                        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
                        <span>recording</span>
                      </span>
                    )}
                  </div>

                  {/* S22 / S24 — clipboard push and local session recording. */}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!clipReady}
                      onClick={() => void pushClipboard()}
                    >
                      Send clipboard
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={recording ? "destructive" : "outline"}
                      onClick={() => void toggleRecording(s.id)}
                    >
                      {recording ? "Stop recording" : "Record session"}
                    </Button>
                  </div>




                  {s.mode === "control" && s.device_id && (
                    <>
                      <VirtualTrackpad
                        onMove={(dx, dy) => void sendInput(s.id, "mousemove_rel", { dx, dy })}
                        onClick={(button) => {
                          void sendInput(s.id, "click", { button });
                          focusLiveSurface();
                        }}
                        onDoubleClick={() => {
                          void sendInput(s.id, "click", { button: 0 });
                          window.setTimeout(() => {
                            void sendInput(s.id, "click", { button: 0 });
                          }, 60);
                          focusLiveSurface();
                        }}
                        onNudge={(dx, dy) => {
                          void sendInput(s.id, "mousemove_rel", { dx, dy });
                        }}
                      />
                      <OnScreenKeyboard
                        onKey={(vk) => {
                          void sendInput(s.id, "key_sequence", {
                            events: [
                              { vk, down: true },
                              { vk, down: false },
                            ],
                          });
                          focusLiveSurface();
                        }}
                        onCombo={(vks) => {
                          void sendInput(s.id, "key_sequence", {
                            events: [
                              ...vks.map((vk) => ({ vk, down: true })),
                              ...[...vks].reverse().map((vk) => ({ vk, down: false })),
                            ],
                          });
                          focusLiveSurface();
                        }}
                      />
                    </>
                  )}
                </div>
                {s.device_id && role !== "viewer" && s.mode === "control" && (
                  <div className="border-t border-white/10 bg-[#0B1220] px-5 py-3">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
                      Typing tunnel to remote PC
                    </label>
                    <div className="mt-2 flex items-start gap-2">
                      <textarea
                        value={sharedNote}
                        onChange={() => {
                          /* input is mirrored from key events so shortcuts never affect this local field */
                        }}
                        onPaste={(e) => pasteToRemote(s.id, e)}
                        onKeyDown={(e) => sendKeyboardDown(s.id, e, true)}
                        onKeyUp={(e) => sendKeyboardUp(s.id, e)}
                        placeholder="Type here to send keystrokes to the focused app on the remote PC."
                        rows={2}
                        className="flex-1 resize-none rounded border border-white/10 bg-[#0F172A] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-[#4F7CFF] focus:outline-none"
                      />
                      <div className="flex flex-col gap-2">
                        <button
                          onClick={() => {
                            if (sharedNote)
                              void sendInput(s.id, "unicode_text", { text: sharedNote });
                          }}
                          className="rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium hover:opacity-90"
                        >
                          Type
                        </button>
                        <button
                          onClick={() => setSharedNote("")}
                          className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {s.device_id && role !== "viewer" && (
                  <SessionFilesPanel sessionId={s.id} getRtc={() => rtcRef.current} />
                )}

              </div>
            </div>
          );
        })()}
    </div>
  );
}
