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
import { isPowerKindAllowed, normalizePlatform, releaseProductFor, isUpdateAvailable, type PowerKind } from "@/shared/platform";
import {
  type Device,
  type Session,
  type LiveFrame,
  type LiveCursor,
  type Nav,
  NAV_VALUES,
} from "@/lib/console-types";
import { keyToVirtualKey, getContainedPoint } from "@/lib/console-input";
import { VirtualTrackpad } from "@/components/console/VirtualTrackpad";
import { OnScreenKeyboard } from "@/components/console/OnScreenKeyboard";
import { SessionFilesPanel } from "@/components/console/SessionFilesPanel";

import { StatCard } from "@/components/console/StatCard";
import { AccessWorkspace } from "@/components/console/AccessWorkspace";
import { LayoutGrid, ListChecks, Monitor as MonitorIcon, Radio, ScrollText, Settings, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SessionsTable } from "@/components/console/SessionsTable";
import { TelegramSettings } from "@/components/console/TelegramSettings";
import { TeamPanel } from "@/components/console/TeamPanel";
import { ReaperPanel } from "@/components/console/ReaperPanel";
import { ExpectedDevicesPanel } from "@/components/console/ExpectedDevicesPanel";
import { RenderHealthPanel } from "@/components/console/RenderHealthPanel";
import { AuditPanel } from "@/components/console/AuditPanel";
import { RemoteCursorOverlay } from "@/components/console/RemoteCursorOverlay";
import { RemoteDisplayFrame } from "@/components/console/RemoteDisplayFrame";
import { DevicePairingDialog } from "@/components/console/DevicePairingDialog";
import { revokeManagedDeviceAccess } from "@/lib/device-pairing.functions";
import { useLiveAuthorization } from "@/lib/use-live-authorization";
import type { AgentMode } from "@/lib/browser-actions";
import { videoSessionStatus } from "@/lib/video-session-status";
import type { ViewerScaleMode } from "@/lib/viewer-geometry";
import { useVideoSourceSize } from "@/lib/use-video-source-size";
import { MonitorPicker, type MonitorEntry } from "@/components/console/MonitorPicker";
import { usesLegacyActions } from "@/shared/legacy-monitor";
import { requestLegacyMonitor } from "@/lib/legacy-monitor.functions";
import { requestAgentRelaunch } from "@/lib/agent-lifecycle.functions";
import { devicePresence, deviceRuntime, runtimeDescription, type AgentRuntime, type RelaunchCommand } from "@/shared/agent-lifecycle";
import type { CurtainState } from "@/lib/browser-curtain";


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
  const relaunchAgent = useServerFn(requestAgentRelaunch);
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
  // Explicit fullscreen for the viewer panel; normal mode stays compact.
  const viewerPanelRef = useRef<HTMLDivElement | null>(null);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setViewerFullscreen(!!viewerPanelRef.current && document.fullscreenElement === viewerPanelRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
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
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<Record<string, AgentRuntime>>({});
  const [relaunches, setRelaunches] = useState<Record<string, RelaunchCommand>>({});
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [relaunching, setRelaunching] = useState(false);
  const [latestVersions, setLatestVersions] = useState<{ agent: string | null; android: string | null }>({ agent: null, android: null });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<Tables<"audit_logs">[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [userId, setUserId] = useState<string | null>(null);
  const [liveId, setLiveId] = useState<string | null>(null);
  const currentLiveSession = sessions.find((s) => s.id === liveId);
  const liveSurfaceDeviceId = currentLiveSession?.device_id;
  const activeLiveId = currentLiveSession?.state === "active" ? currentLiveSession.id : null;
  const liveVideoOnly = currentLiveSession?.media_mode === "video";
  const liveAuthorization = useLiveAuthorization(activeLiveId, currentLiveSession?.authorization_id ?? null);
  const legacyActions = usesLegacyActions(currentLiveSession?.media_mode,
    devices.find(device => device.id === liveSurfaceDeviceId)?.metadata);
  const [agentMode, setAgentMode] = useState<AgentMode>(null);
  const [curtain, setCurtain] = useState<CurtainState>({ supported: false, active: null, pending: false, reason: null });
  const controlGranted = currentLiveSession?.mode === "control" && (legacyActions || agentMode === "control") &&
    liveAuthorization.grant?.capabilities.control === true;
  const [viewerAttempt, setViewerAttempt] = useState(0);
  const [viewerPaused, setViewerPaused] = useState(false);
  const [viewerUnsupported, setViewerUnsupported] = useState(false);
  const viewerStartedAtRef = useRef(0);
  const lastInputNoticeRef = useRef(0);
  const [monitorSwitching, setMonitorSwitching] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null);
  const fpsCounterRef = useRef({ count: 0, lastReset: Date.now(), fps: 0 });
  const lastRealtimePushAtRef = useRef<number>(0);
  const [realtimeStatus, setRealtimeStatus] = useState<
    "connecting" | "subscribed" | "reconnecting" | "closed"
  >("connecting");
  // WebRTC video is the primary surface; the JPEG frame pipe is the fallback.
  const [rtcState, setRtcState] = useState<WebRtcState>("idle");
  const controlReady = controlGranted && rtcState === "connected";
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
  // Viewer geometry (presentation only): reactive video dimensions, local
  // Fit / 1:1 scale mode and the collapsible action rail.
  const [viewerVideo, setViewerVideo] = useState<HTMLVideoElement | null>(null);
  const videoSourceSize = useVideoSourceSize(viewerVideo, liveId);
  const [viewerScaleMode, setViewerScaleMode] = useState<ViewerScaleMode>("fit");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const revokeAccess = useServerFn(revokeManagedDeviceAccess);
  const [revokingAccess, setRevokingAccess] = useState(false);
  useEffect(() => {
    setViewerScaleMode("fit");
    setFilesOpen(false);
    setLiveFrame(null);
  }, [liveId]);
  const videoDecodingRef = useRef(false);
  videoDecodingRef.current = videoDecoding;

  const [liveCursor, setLiveCursor] = useState<LiveCursor | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const search = Route.useSearch();
  const [nav, setNav] = useState<Nav>(search.tab ?? "devices");
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
    // Unknown and migrated sessions never start a JPEG pipeline.
    const wantFrames = currentLiveSession?.media_mode === "legacy" && !videoDecoding && !viewerPaused;
    if (!wantFrames) setLiveFrame(null);

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
          if (cancelled) return;
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
        if (cancelled) return;
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
  }, [liveId, currentLiveSession?.media_mode, videoDecoding, viewerPaused]);

  useEffect(() => {
    setAgentMode(null);
    setViewerPaused(false);
    setViewerUnsupported(false);
    if (!activeLiveId) {
      rtcRef.current?.close();
      rtcRef.current = null;
      setViewerVideo(null);
      setRtcState("idle");
      setFilesReady(false);
      return;
    }
    if (typeof RTCPeerConnection !== "function") {
      setViewerUnsupported(true);
      setRtcState("failed");
      return;
    }
    viewerStartedAtRef.current = Date.now();
    const live = startWebRtcLive(activeLiveId, {
      videoOnly: liveVideoOnly, authorizationId: currentLiveSession?.authorization_id,
    });
    rtcRef.current = live;
    setViewerVideo(live.video);
    live.onRecording((active) => {
      if (rtcRef.current === live) setRecording(active);
    });
    setRtcState(live.state());
    live.onState((s) => {
      if (rtcRef.current === live) setRtcState(s);
    });
    const offMode = live.onAgentMode(mode => {
      if (rtcRef.current === live) setAgentMode(mode);
    });
    const offCurtain = live.onCurtain(state => {
      if (rtcRef.current === live) setCurtain(state);
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
      offMode();
      offCurtain();
      setCurtain({ supported: false, active: null, pending: false, reason: null });
      window.clearInterval(filesTick);
      if (rtcRef.current === live) rtcRef.current = null;
      setViewerVideo((current) => current === live.video ? null : current);
      setRtcState("idle");
      setFilesReady(false);
      setClipReady(false);
      setRecording(false);
      live.close();
    };
  }, [activeLiveId, liveVideoOnly, currentLiveSession?.authorization_id, viewerAttempt]);

  /** S22 — push the technician's local clipboard to the remote machine. */
  async function pushClipboard() {
    if (!liveAuthorization.grant?.capabilities.clipboard) {
      toast.error("Clipboard exchange is not authorized for this session.");
      return;
    }
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
    if (live.sendClipboard(text)) toast.info("Clipboard queued on the live channel; remote application is not confirmed.");
    else toast.error("Clipboard send failed");
  }

  /** S24 — start/stop a local WEBM recording of the live video track. */
  async function toggleRecording(sessionId: string) {
    const live = rtcRef.current;
    if (!live) return;
    if (!live.recording() && !liveAuthorization.grant?.capabilities.recording) {
      toast.error("Recording is not authorized for this session.");
      return;
    }
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
    if (await live.startRecording()) {
      setRecording(true);
      toast.success("Recording started");
    } else {
      toast.error("Recording unavailable: permission was denied, expired, or could not be verified.");
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
  }, [liveId, rtcVideoLive, liveSurfaceDeviceId, viewerVideo]);

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
    if ((!controlReady || viewerPaused) && document.pointerLockElement === liveSurfaceRef.current)
      document.exitPointerLock();
  }, [controlReady, viewerPaused]);

  async function refresh() {
    const [d, s, a, releases, runtime, commands] = await Promise.all([
      supabase.from("devices").select("*").order("last_seen_at", { ascending: false }),
      supabase.from("sessions").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("releases").select("product, version, published_at").eq("published", true).eq("channel", "stable").in("product", ["agent", "android"]).order("published_at", { ascending: false }),
      supabase.from("agent_runtime").select("*"),
      supabase.from("agent_lifecycle_commands").select("*").order("requested_at", { ascending: false }).limit(100),
    ]);
    if (runtime.error || commands.error) {
      setLifecycleError("Recovery status could not be loaded. Check server connectivity and the lifecycle migration; relaunch is disabled.");
      setRuntimes({});
      setRelaunches({});
    } else {
      setLifecycleError(null);
      setRuntimes(Object.fromEntries((runtime.data ?? []).map(row => [row.device_id, row])));
      const latest: Record<string, RelaunchCommand> = {};
      for (const row of commands.data ?? []) if (!latest[row.device_id]) latest[row.device_id] = row;
      setRelaunches(latest);
    }
    if (d.error) {
      setDevicesError(d.error.message || "The device list request failed.");
    } else {
      setDevicesError(null);
      if (d.data) setDevices(d.data);
      setDevicesLoaded(true);
    }
    if (s.data) setSessions(s.data);
    if (a.data) setAudit(a.data);
    if (releases.data) {
      const latest = { agent: null as string | null, android: null as string | null };
      for (const row of releases.data) {
        if (row.product === "agent" && latest.agent === null) latest.agent = row.version;
        if (row.product === "android" && latest.android === null) latest.android = row.version;
      }
      setLatestVersions(latest);
    }
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
    return devicePresence(d, now, runtimes[d.id]);
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
          `Agent reported a stopped state on <b>${d.display_name ?? "Device"}</b>. Check authorized startup and local access status; a restart is not guaranteed.`,
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

  // Invite an enrolled device. The Agent checks its standing grant; attended
  // sessions require local acceptance. Video starts only after activation.
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
        media_mode: d.platform === "windows" &&
          (d.metadata as Record<string, unknown> | null)?.browser_video === 1 ? "video" : "legacy",
      })
      .select()
      .single();
    if (error) return alert(error.message);
    if (data) {
      setSessions(previous => [data, ...previous.filter(session => session.id !== data.id)]);
      setLiveId(data.id);
    }
  }

  async function endSession(s: Session) {
    await sendInput(s.id, "release_inputs", {});
    await sendInput(s.id, "curtain_off", {});
    const { data: ended, error } = await supabase
      .from("sessions")
      .update({ state: "ended", ended_at: new Date().toISOString(), pairing_code: null })
      .eq("id", s.id).select("id").maybeSingle();
    if (error || !ended) { toast.error("The session could not be ended."); return; }
    setLiveId(current => current === s.id ? null : current);
    const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
    void pushNotify("session_end", `⏹️ Session ended on <b>${dev?.display_name ?? "device"}</b>`);
  }

  async function deleteSession(s: Session) {
    if (!confirm("Delete this session permanently?")) return;
    const { error } = await supabase.from("sessions").delete().eq("id", s.id);
    if (error) alert(error.message);
  }

  async function queuePower(d: Device, kind: PowerKind) {
    const platform = normalizePlatform(d.platform);
    if (!isPowerKindAllowed(platform, kind)) {
      alert("That action is not supported on this device.");
      return;
    }
    const labels: Record<PowerKind, string> = {
      wake: "Send Wake-on-LAN magic packet",
      wake_agent: "Wake the Windows agent",
      reboot: platform === "android" ? "Reboot the Android device" : "Reboot the remote machine in 5 seconds",
      shutdown: "Shut down the remote machine in 5 seconds",
      lock: "Lock the remote device",
      logoff: "Sign out the current user",
      restart_stream: "Restart the live stream",
      restart_agent: "Restart the Windows agent",
      switch_monitor: "Switch monitor",
      restart_app: "Restart the Android app",
    };
    if (kind === "reboot" || kind === "shutdown" || kind === "restart_app") {
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
    if (nextMode === "control" && !liveAuthorization.grant?.capabilities.control) {
      toast.error("Keyboard/mouse control is not authorized.");
      return;
    }
    const { data: changed, error: modeError } = await supabase.from("sessions")
      .update({ mode: nextMode }).eq("id", s.id).eq("state", "active").select("id").maybeSingle();
    if (modeError || !changed) {
      toast.error(modeError?.message ?? "Session is no longer active or access was denied.");
      return;
    }
    // Keyboard/mouse control is not a privacy curtain or a local input lock.
    if (nextMode === "view") {
      await sendInput(s.id, "release_inputs", {});
      await sendInput(s.id, "curtain_off", {});
    }
    toast.info("Mode requested; waiting for the Agent to acknowledge it.");
    const dev = s.device_id ? devices.find((d) => d.id === s.device_id) : null;
    void pushNotify(
      nextMode === "control" ? "control_taken" : "control_released",
      nextMode === "control"
        ? `Keyboard/mouse control requested for <b>${dev?.display_name ?? "device"}</b>; awaiting Agent acknowledgement.`
        : `View-only mode requested for <b>${dev?.display_name ?? "device"}</b>; awaiting Agent acknowledgement.`,
    );
  }

  async function requestReconnect(s: Session) {
    await restartStream(s);
  }

  // Enqueue a mouse/keyboard event for the agent to replay via SendInput.
  // Coordinates are normalized (0..1) relative to the rendered surface.
  async function sendInput(sessionId: string, kind: string, payload: Record<string, unknown>) {
    const live = rtcRef.current;
    const cleanup = kind === "release_inputs" || kind === "curtain_off";
    if (!cleanup && (live?.sessionId !== sessionId || !controlReady || viewerPaused || role === "viewer")) return;
    const target = sessions.find(session => session.id === sessionId);
    const sentRealtime = live?.sessionId === sessionId && live.sendInput({ kind, payload });
    if (sentRealtime) return;
    if (!target || target.media_mode === "video") {
      if (!["mousemove", "mousemove_rel", "wheel", "release_inputs", "curtain_off"].includes(kind) &&
          Date.now() - lastInputNoticeRef.current > 2000) {
        lastInputNoticeRef.current = Date.now();
        toast.error("Live input is unavailable. No input was queued.");
      }
      return;
    }
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

  // Losing browser focus releases held keys/buttons. It never enables privacy.
  useEffect(() => {
    const live = rtcRef.current;
    if (!live) return;
    const release = () => { live.sendInput({ kind: "release_inputs", payload: {} }); };
    const onHide = () => {
      if (document.visibilityState === "hidden") release();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", release);
      release();
    };
  }, [activeLiveId, viewerAttempt]);

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
    if (!selectedDevices.length || relaunching) return;
    if (lifecycleError) { toast.error(lifecycleError); return; }
    if (selectedDevices.length > 50 || selectedDevices.some(d => normalizePlatform(d.platform) !== "windows")) {
      toast.error("Select up to 50 Windows devices for this Agent recovery action."); return;
    }
    if (!confirm(`Ask authorized Watch companions to relaunch ${selectedDevices.length} absent Agent(s)? Healthy Agents stay running; local disable is never overridden.`)) return;
    setRelaunching(true);
    try {
      let accepted = 0;
      const failures: string[] = [];
      for (let index = 0; index < selectedDevices.length; index += 5) {
        const batch = await Promise.allSettled(selectedDevices.slice(index, index + 5).map(d =>
          relaunchAgent({ data: { deviceId: d.id } })));
        for (const result of batch) {
          if (result.status === "fulfilled") accepted++;
          else failures.push(result.reason instanceof Error ? result.reason.message : "Recovery request failed.");
        }
      }
      if (accepted) toast.info(`${accepted} recovery request(s) recorded. Follow the Agent acknowledgements in the device list.`);
      if (failures.length) toast.error(`${failures.length} request(s) rejected. ${failures[0]}`);
      await refresh();
    } finally { setRelaunching(false); }
  }

  // Reconnect only this viewer. This is not an Agent process relaunch.
  async function restartStream(s: Session) {
    if (s.state !== "active") { toast.info("Wait for an authorized active session before reconnecting."); return; }
    setLiveId(s.id);
    setViewerAttempt(value => value + 1);
  }

  // Current receivers acknowledge direct requests. Older receivers have only
  // the scoped capture queue; queued must never be presented as applied.
  async function switchMonitor(s: Session, m: MonitorEntry) {
    const live = rtcRef.current;
    if (s.id !== liveId || !live || !liveAuthorization.grant?.capabilities.view) return;
    setMonitorSwitching(true);
    try {
      if (legacyActions) {
        await requestLegacyMonitor({ data: { sessionId: s.id, deviceName: m.device_name } });
        toast.info("Legacy display request queued for up to 10 seconds. Application is not confirmed; check the reported display.");
      } else {
        await live.selectMonitor(m.device_name);
        toast.success("Agent confirmed the display selection; waiting for updated video.");
      }
      setLiveCursor(null);
      void refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Display selection failed."); }
    finally { setMonitorSwitching(false); }
  }



  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/connectlive/admin" });
  }

  const reconnecting = devices.filter((d) => presenceOf(d) === "reconnecting");
  const onlineCount = devices.filter((d) => presenceOf(d) === "online").length;
  const activeSessions = sessions.filter((s) => s.state === "active" || s.state === "paused");
  const pendingSessions = sessions.filter((s) => s.state === "invited");

  // Fail closed: only resolved staff roles that may operate devices.
  const canMutate = role === "super_admin" || role === "admin" || role === "technician";
  const isAdmin = role === "super_admin" || role === "admin";
  const railItems: { id: Nav; label: string; icon: typeof MonitorIcon; badge?: number }[] = [
    { id: "devices", label: "Access", icon: MonitorIcon, badge: onlineCount },
    { id: "dashboard", label: "Overview", icon: LayoutGrid },
    { id: "sessions", label: "Sessions", icon: Radio, badge: activeSessions.length },
    { id: "expected", label: "Expected", icon: ListChecks },
    { id: "audit", label: "Audit", icon: ScrollText },
    ...(role === "super_admin"
      ? [
          { id: "team" as Nav, label: "Team", icon: Users },
          { id: "settings" as Nav, label: "Settings", icon: Settings },
        ]
      : []),
  ];
  const navTitle: Record<Nav, string> = {
    devices: "Access", dashboard: "Overview", sessions: "Sessions", expected: "Expected devices",
    audit: "Audit log", team: "Team", settings: "Settings",
  };

  return (
    <div className="min-h-[100dvh] bg-[#0B1220] text-white">
      <div className="flex min-h-[100dvh] flex-col md:h-[100dvh] md:flex-row">
        {/* Navigation rail */}
        <aside
          aria-label="Console navigation"
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/10 bg-[#070D1A] px-2 py-1.5 md:w-[76px] md:flex-nowrap md:flex-col md:overflow-visible md:border-b-0 md:border-r md:px-0 md:py-3"
        >
          <div className="mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#4F7CFF]/15 md:mb-3 md:mr-0" title="ConnectLive">
            <span className="h-3 w-3 rounded-full bg-[#4F7CFF] shadow-[0_0_0_4px_rgba(79,124,255,0.2)]" />
          </div>
          <nav className="order-last grid w-full grid-cols-4 gap-1 md:order-none md:flex md:flex-1 md:flex-col md:gap-0.5">
            {railItems.map(({ id, label, icon: Icon, badge }) => (
              <button
                key={id}
                type="button"
                onClick={() => setNav(id)}
                aria-current={nav === id ? "page" : undefined}
                data-testid={`nav-${id}`}
                className={`relative flex min-w-0 shrink-0 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 md:px-2.5 text-[10px] transition focus-visible:outline-2 focus-visible:outline-[#7FA0FF] md:mx-1.5 md:py-2 ${
                  nav === id
                    ? "bg-[#4F7CFF]/20 text-white md:shadow-[inset_3px_0_0_#4F7CFF]"
                    : "text-white/55 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden />
                <span>{label}</span>
                {badge !== undefined && badge > 0 && (
                  <span className="absolute right-1 top-0.5 rounded-full bg-[#4F7CFF] px-1 font-mono text-[9px] leading-[14px] text-white">{badge}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0 md:mt-auto md:flex-col md:gap-2 md:rounded-2xl md:bg-white/[0.04] md:px-1.5 md:py-2">
            <NotificationBell userId={userId} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Account ${userEmail}`}
                  data-testid="button-account"
                  className="grid h-8 w-8 place-items-center rounded-full bg-[#4F7CFF] text-xs font-semibold uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B9CCFF]"
                >
                  {(userEmail || "?").slice(0, 1)}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" collisionPadding={8} className="min-w-52 border-white/10 bg-[#0F172A] text-white">
                <DropdownMenuLabel className="truncate text-xs font-normal text-white/70">{userEmail || "Signed in"}</DropdownMenuLabel>
                <DropdownMenuLabel className="pt-0 text-[10px] uppercase tracking-wider text-[#B9CCFF]">
                  {role ? role.replace("_", " ") : "role loading"}
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-white/10" />
                <DropdownMenuItem className="cursor-pointer text-xs focus:bg-[#4F7CFF]/20 focus:text-white" onSelect={() => void signOut()} data-testid="button-sign-out">
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {reconnecting.length > 0 && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200 sm:px-6">
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              {reconnecting.length} device{reconnecting.length > 1 ? "s" : ""} reconnecting...
            </div>
          )}

          {nav === "devices" ? (
            <AccessWorkspace
              devices={devices}
              sessions={sessions}
              latestVersions={latestVersions}
              presenceOf={presenceOf}
              now={now}
              loading={!devicesLoaded}
              loadError={devicesError}
              onRetry={() => void refresh().catch((e: unknown) => setDevicesError(e instanceof Error ? e.message : "Device refresh failed."))}
              selected={selected}
              setSelected={setSelected}
              canConnect={canMutate}
              canPower={canMutate && (isAdmin || role === "technician")}
              canShutdown={isAdmin}
              canDelete={isAdmin}
              canRelaunch={isAdmin}
              canPair={isAdmin}
              relaunching={relaunching}
              lifecycleError={lifecycleError}
              lifecycleStatus={d => {
                const command = relaunches[d.id];
                const expired = command && ["queued", "received", "starting"].includes(command.state) && Date.parse(command.expires_at) <= now;
                return runtimeDescription(deviceRuntime(d, runtimes[d.id]), now) + (command
                  ? ` · Relaunch: ${expired ? "expired" : command.state.replaceAll("_", " ")}${command.detail_code ? ` (${command.detail_code.replaceAll("_", " ")})` : ""}` : "");
              }}
              onConnect={connectDevice}
              onPower={(d, kind) => queuePower(d, kind)}
              onBulkEnd={bulkEndSessions}
              onBulkRestart={bulkRestartAgent}
              onPair={() => setPairingOpen(true)}
              onOpenExpected={() => setNav("expected")}
              onDelete={async (d) => {
                if (!isAdmin) return;
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
          ) : (
          <>
          <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
            <h1 className="truncate text-lg font-semibold">{navTitle[nav]}</h1>
            {canMutate && (
              <Button size="sm" onClick={() => setPairingOpen(true)} className="bg-[#4F7CFF] text-white hover:bg-[#6189FF]">Pair device</Button>
            )}
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">

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
                <AuditPanel key={userId ?? "signed-out"} userId={userId} devices={devices} />
                <ReaperPanel audit={audit} devices={devices} />
                <RenderHealthPanel />
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
          </>
          )}
        </div>
      </div>

      {/* Live view modal */}
      <DevicePairingDialog open={pairingOpen} onOpenChange={setPairingOpen} />
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
          const legacyStreamTone =
            streamState === "live"
              ? "bg-emerald-400"
              : streamState === "lag" || streamState === "waiting" || streamState === "reconnecting"
                ? "bg-amber-400"
                : "bg-rose-500";
          const legacyStreamCopy = {
            live: "Live",
            lag: "Lagging",
            stalled: "Stalled",
            waiting: "Waiting for first frame",
            reconnecting: "Device reconnecting",
            paused: "Session paused",
          }[streamState];
          const videoStatus = videoSessionStatus({
            sessionState: s.state, supported: !viewerUnsupported, viewerPaused,
            deviceOnline: presence === "online", rtcState, decoding: videoDecoding,
            attemptAgeMs: now - viewerStartedAtRef.current,
          });
          const streamTone = liveVideoOnly ? videoStatus.tone : legacyStreamTone;
          const streamCopy = liveVideoOnly ? videoStatus.label :
            viewerPaused ? "Viewer paused — sharing continues" : legacyStreamCopy;
          const control = controlReady && role !== "viewer" && !viewerPaused;
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
          const iceKind = rtcState === "connected" ? rtcRef.current?.candidateType?.() ?? null : null;
          const actionButtonClass = "border-white/15 bg-transparent text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-50";
          // S16 — a deployment with no TURN relay cannot traverse symmetric NAT,
          // so the session sits on JPEG frames forever. Name it in the pill
          // instead of leaving "Frame fallback" looking like an agent problem.
          const relay = rtcRef.current?.relay?.() ?? "pending";
          const noRelay = relay === "none" && !videoDecoding;
          const videoLabel = `WebRTC video${iceKind ? ` · ${iceKind}` : ""}${videoFps ? ` · ${videoFps} fps` : ""}`;
          const legacyTransportLabel = {
            connecting: "Connecting",
            video: videoLabel,
            negotiating: `WebRTC negotiating${iceKind ? ` · ${iceKind}` : ""} · no frames yet`,
            live: `Frame fallback (${fpsCounterRef.current.fps} fps)${noRelay ? " · no relay" : ""}`,
            reconnecting: "Reconnecting",
            polling: `Frame fallback (polling)${noRelay ? " · no relay" : ""}`,
          }[transport];
          const transportLabel = liveVideoOnly
            ? videoDecoding || viewerPaused
              ? `WebRTC video${iceKind === "relay" ? " · TURN" : iceKind ? " · direct" : " · path unverified"}`
              : `${streamCopy} · video only${noRelay ? " · TURN unavailable" : ""}`
            : legacyTransportLabel;


          const displaySource =
            liveVideoOnly || videoDecoding || viewerPaused
              ? videoSourceSize
              : liveFrame?.frame && liveFrame?.width && liveFrame?.height
                ? { width: liveFrame.width, height: liveFrame.height }
                : videoSourceSize;
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4"
              onClick={() => setLiveId(null)}
            >
              <div
                ref={viewerPanelRef}
                className={viewerFullscreen
                  ? "flex h-full w-full flex-col overflow-y-auto overflow-x-hidden bg-[#0F172A]"
                  : "flex max-h-[calc(100dvh-1rem)] w-full max-w-[min(100%,1280px)] flex-col overflow-y-auto overflow-x-hidden rounded-xl border border-white/10 bg-[#0F172A] shadow-2xl sm:max-h-[calc(100dvh-2rem)]"}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[#4F7CFF] animate-pulse" : "bg-amber-400"}`}
                    />
                    <div>
                      <div className="text-sm font-semibold">
                        {dev?.display_name ?? "Waiting for agent…"}
                      </div>
                      <div className="text-xs text-white/50">
                        {s.mode === "control" ? (legacyActions ? "Control authorized — legacy receiver unconfirmed" : controlReady ? "Agent control ready" : "Control requested — awaiting Agent") : "View mode"} · {s.state} ·{" "}
                        {streamCopy}
                      </div>
                    </div>
                    <span
                      title={`WebRTC: ${rtcState}. TURN: ${relay === "relay" ? "configured (availability only, not proof of use)" : relay === "none" ? "not configured, direct paths only" : "resolving"}. Selected path: ${iceKind ? (iceKind === "relay" ? "relay (TURN in use)" : iceKind) : "not yet selected"}. Realtime socket: ${realtimeStatus}. Last frame push ${Number.isFinite(rtSinceLastPush) ? `${Math.round(rtSinceLastPush)}ms ago` : "never"}.`}
                      className="ml-2 flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/80"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${transportTone} ${transport === "video" ? "animate-pulse" : ""}`}
                      />
                      {transportLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="button-toggle-rail"
                      aria-expanded={!railCollapsed}
                      aria-controls="viewer-action-rail"
                      onClick={() => setRailCollapsed((v) => !v)}
                      className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                    >
                      {railCollapsed ? "Show actions" : "Hide actions"}
                    </button>
                    <button
                      onClick={() => {
                        const el = viewerPanelRef.current;
                        if (!el) return;
                        if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => toast.error("Could not exit fullscreen"));
                        else if (el.requestFullscreen) void el.requestFullscreen().catch(() => toast.error("Fullscreen unavailable"));
                        else toast.error("Fullscreen unavailable");
                      }}
                      className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                      title={viewerFullscreen ? "Exit fullscreen (Esc)" : "Show the remote screen fullscreen"}
                    >
                      {viewerFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    </button>
                    <button
                      onClick={() => setLiveId(null)}
                      className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                    >
                        Close viewer
                    </button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                  {!railCollapsed && (
                    <nav
                      id="viewer-action-rail"
                      aria-label="Session actions"
                      className="flex shrink-0 flex-row flex-wrap gap-1.5 border-b border-white/10 bg-[#0B1220] p-2 md:w-48 md:flex-col md:flex-nowrap md:overflow-y-auto md:border-b-0 md:border-r [&_button]:text-left md:[&>button]:w-full"
                    >
                      <div className="hidden px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40 md:block">
                        Session actions
                      </div>
                    {s.device_id && role !== "viewer" && (
                      <MonitorPicker
                        device={dev}
                        disabled={monitorSwitching || (!legacyActions && !agentMode) || !liveAuthorization.grant?.capabilities.view}
                        onSelect={(m) => void switchMonitor(s, m)}
                      />
                    )}
                    {s.device_id && role !== "viewer" && (

                      <button
                        onClick={() => {
                          setLiveFrame(null);
                          setLiveCursor(null);
                          void restartStream(s);
                        }}
                        className="rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
                        disabled={!active}
                        title="Reconnect this browser's video peer without changing device authorization or waking a stopped Agent"
                      >
                        Reconnect viewer
                      </button>
                    )}
                    {s.device_id && role !== "viewer" && (
                      <button
                        onClick={() => toggleControl(s)}
                        disabled={!active || !agentMode || !liveAuthorization.grant?.capabilities.control}
                        className={`rounded px-3 py-1.5 text-xs font-medium ${s.mode === "control" ? "bg-red-500/90 hover:bg-red-500 text-white" : "bg-white/10 hover:bg-white/15"}`}
                        title={
                          s.mode === "control"
                            ? "Existing action: switch this session back to view mode"
                            : "Existing action: request control mode for this session"
                        }
                      >
                        {s.mode === "control" ? "Release control mode" : "Request control mode"}
                      </button>
                    )}
                    {s.device_id && control && (
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
                        {pointerLocked ? "Pointer locked" : "Capture pointer"}
                      </button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={actionButtonClass}
                      disabled={!clipReady || !liveAuthorization.grant?.capabilities.clipboard}
                      title={!liveAuthorization.grant?.capabilities.clipboard ? "Clipboard was not included in this authorization." : "Requires the live clipboard channel."}
                      onClick={() => void pushClipboard()}
                    >
                      Send clipboard
                    </Button>
                    <Button type="button" size="sm" variant="outline"
                      className={actionButtonClass}
                      disabled={!liveAuthorization.grant?.capabilities.files || role === "viewer"}
                      title={!liveAuthorization.grant?.capabilities.files ? "File exchange was not included in this authorization." : "Open session files"}
                      onClick={() => setFilesOpen(value => !value)}>
                      {filesOpen ? "Hide files" : "Files"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={recording ? "destructive" : "outline"}
                      className={recording ? undefined : actionButtonClass}
                      disabled={!recording && (!videoDecoding || !liveAuthorization.grant?.capabilities.recording)}
                      onClick={() => void toggleRecording(s.id)}
                    >
                      {recording ? "Stop recording" : "Record session"}
                    </Button>
                    <Button
                      type="button" size="sm" variant="outline"
                      className={actionButtonClass}
                      disabled={!viewerPaused && !videoDecoding}
                      title="Pauses playback here only. End sharing to stop the remote session."
                      onClick={() => {
                        if (!viewerVideo) return;
                        if (!viewerPaused) { viewerVideo.pause(); setViewerPaused(true); }
                        else void viewerVideo.play().then(() => setViewerPaused(false))
                          .catch(() => toast.error("Playback could not resume. Reconnect the viewer."));
                      }}
                    >
                      {viewerPaused ? "Resume viewer" : "Pause viewer"}
                    </Button>
                    <Button type="button" size="sm" variant={curtain.active ? "destructive" : "outline"}
                      className={curtain.active ? undefined : actionButtonClass}
                      disabled={!curtain.supported || curtain.pending || (curtain.active === false && !controlReady)}
                      aria-pressed={curtain.active === true}
                      title="Shows a local maintenance notice and pauses ordinary local input. Ctrl+Alt+Shift+Esc on the device stops remote access."
                      onClick={async () => {
                        try { await rtcRef.current?.setCurtain(curtain.active === false); }
                        catch (error) { toast.error(error instanceof Error ? error.message : "Curtain request failed."); }
                      }}>
                      {curtain.pending ? "Waiting for Agent…" : curtain.active === null ? "Clear unconfirmed curtain" :
                        curtain.active ? "Turn curtain off" : "Privacy curtain"}
                    </Button>
                    <p aria-live="polite" className="max-w-xs px-1 py-1 text-[10px] leading-relaxed text-white/50">
                      {!curtain.supported ? "This Agent has not advertised browser curtain support." :
                        curtain.active === true ? "Agent confirmed local curtain. The notice is on the remote device, not this viewer." :
                        curtain.reason ? `Curtain: ${curtain.reason.replaceAll("_", " ")}. No automatic reactivation.` : "Curtain is off until explicitly enabled."}
                      {" "}Windows secure-desktop access is not enabled.
                    </p>
                    {liveAuthorization.error && <p role="alert" className="px-1 text-xs text-amber-200">{liveAuthorization.error}</p>}
                    <details className="max-w-xs rounded border border-white/10 px-3 py-1.5 text-xs">
                      <summary className="cursor-pointer">Device details</summary>
                      <dl className="mt-2 space-y-1 break-words text-white/60">
                        <dt>Hostname</dt><dd className="text-white">{dev?.hostname ?? "Not reported"}</dd>
                        <dt>Operating system</dt><dd className="text-white">{dev?.os ?? "Not reported"}</dd>
                        <dt>Last check-in</dt><dd className="text-white">{dev?.last_seen_at ? new Date(dev.last_seen_at).toLocaleString() : "Never"}</dd>
                      </dl>
                    </details>
                    {role !== "viewer" && (
                      <button
                        onClick={() => void endSession(s)}
                        className="rounded bg-red-500/80 px-3 py-1.5 text-xs"
                      >
                        End sharing
                      </button>
                    )}
                    {s.device_id && role !== "viewer" && (
                      <button
                        disabled={revokingAccess}
                        onClick={async () => {
                          if (!s.device_id || !confirm("Revoke this device's remote-access authorization and end its sessions? Local reauthorization will be required.")) return;
                          setRevokingAccess(true);
                          try {
                            await revokeAccess({ data: { deviceId: s.device_id } });
                            toast.success("Remote-access authorization revoked");
                              setLiveId(current => current === s.id ? null : current);
                          } catch (error) {
                            toast.error(error instanceof Error ? error.message : "Could not revoke access");
                          } finally { setRevokingAccess(false); }
                        }}
                        className="rounded border border-red-400/30 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {revokingAccess ? "Revoking access…" : "Revoke device access"}
                      </button>
                    )}
                    </nav>
                  )}
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <RemoteDisplayFrame
                      source={displaySource}
                      mode={viewerScaleMode}
                      onModeChange={setViewerScaleMode}
                      fullscreen={viewerFullscreen}
                      sourceLabel={videoDecoding || !liveFrame?.frame ? "Video" : "Fallback frame"}
                      awaiting={
                        !s.device_id ? (
                          <span className="text-sm text-white/60">Session has no device attached.</span>
                         ) : !videoDecoding && !viewerPaused && !liveFrame?.frame ? (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
                      <div className="flex items-center gap-2 rounded-full border border-[#4F7CFF]/30 bg-[#4F7CFF]/10 px-3 py-1 text-xs text-[#B9CCFF]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[#4F7CFF] animate-pulse" />
                        {streamCopy}
                      </div>
                      <div className="text-sm text-white/60">
                        {presence && presence !== "online"
                          ? "The device heartbeat is stale; awaiting a fresh check-in."
                          : active
                             ? liveVideoOnly
                               ? "Waiting for decoded video. Check the Agent encoder and direct/TURN connectivity; this session never falls back to JPEG."
                               : "Waiting for decoded video or a fresh legacy fallback frame."
                             : "Wait for Agent acceptance, or start a new authorized session."}
                      </div>
                    </div>
                        ) : undefined
                      }
                    >
                  {!s.device_id ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
                      Session has no device attached.
                    </div>
                  ) : (
                    <div
                      ref={liveSurfaceRef}
                      tabIndex={control ? 0 : -1}
                      className={`absolute inset-0 outline-none ${control ? "cursor-crosshair" : ""}`}
                      onMouseMove={
                        control
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
                        control
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
                        control
                          ? (e) => {
                              e.preventDefault();
                              mouseButtonDownRef.current = false;
                              flushMoveNow(s.id);
                              void sendInput(s.id, "mouseup", { button: e.button });
                            }
                          : undefined
                      }
                      onMouseLeave={
                        control
                          ? () => {
                              mouseButtonDownRef.current = false;
                            }
                          : undefined
                      }
                      onContextMenu={control ? (e) => e.preventDefault() : undefined}
                      onWheel={
                        control
                          ? (e) => {
                              e.preventDefault();
                              void sendInput(s.id, "wheel", { dy: e.deltaY });
                            }
                          : undefined
                      }
                      onKeyDown={
                        control ? (e) => sendKeyboardDown(s.id, e) : undefined
                      }
                      onKeyUp={control ? (e) => sendKeyboardUp(s.id, e) : undefined}
                    >
                      {/* Primary layer: the WebRTC video track (hardware-decoded,
                        real frame rate). The element itself is created and owned
                        by startWebRtcLive(); we only host it here. */}
                      <div
                        ref={videoHostRef}
                        className={`pointer-events-none absolute inset-0 ${videoDecoding || viewerPaused ? "" : "opacity-0"}`}
                      />
                      {/* Fallback layer: base64 JPEG slideshow from session_frames.
                        Same object-contain letterboxing so coordinate mapping is
                        identical apart from the source dimensions. */}
                      {!liveVideoOnly && !viewerPaused && !videoDecoding && liveFrame?.frame && (
                        <img
                          src={`data:image/jpeg;base64,${liveFrame.frame}`}
                          alt="Live screen"
                          className="pointer-events-none absolute inset-0 h-full w-full object-contain [image-rendering:auto]"
                          draggable={false}
                          decoding="async"
                        />
                      )}
                    </div>
                  )}
                  {s.device_id &&
                    (videoDecoding || liveFrame?.frame) &&
                    liveCursor &&
                    liveCursor.visible && (
                      <RemoteCursorOverlay cursor={liveCursor} frame={liveFrame} />
                    )}
                    </RemoteDisplayFrame>
                  <div data-testid="status-viewer" className="flex flex-wrap items-center gap-2 border-t border-white/10 px-3 py-1.5 font-mono text-[10px] text-white/70">
                    {(() => {
                      // Stream health: green <2s, amber <8s, red otherwise. Gives the
                      // admin an at-a-glance signal that the frame pipe is healthy
                      // (or lagging) without cluttering the viewport.
                      return (
                        <span className="flex items-center gap-1">
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${streamTone}`} />
                          <span>{liveVideoOnly ? videoStatus.key : streamState}</span>
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
                        : liveVideoOnly ? (viewerPaused ? "viewer paused" : "no decoded video") : `${fpsCounterRef.current.fps} fps frames`}
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
                       <span>{filesReady ? "files: data channel" : "files: archive"}</span>
                    </span>
                    {/* S22 — clipboard channel state. */}
                    <span className="flex items-center gap-1">
                      ·
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          clipReady ? "bg-emerald-400" : "bg-white/30"
                        }`}
                      />
                       <span>{clipReady ? "clipboard channel ready" : "clipboard offline"}</span>
                    </span>
                    {recording && (
                      <span className="flex items-center gap-1 text-red-300">
                        ·
                        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
                        <span>recording</span>
                      </span>
                    )}
                  </div>
                    {control && s.device_id && (
                      <details className="border-t border-white/10">
                        <summary className="cursor-pointer px-3 py-2 text-xs text-white/70">
                          Keyboard and trackpad
                        </summary>
                      <div className="relative min-h-[400px] overflow-hidden">
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
                      </div>
                      </details>
                    )}
                  </div>
                </div>
                {s.device_id && control && (
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
                {s.device_id && role !== "viewer" && liveAuthorization.grant?.capabilities.files && (
                  <div hidden={!filesOpen}>
                    <SessionFilesPanel sessionId={s.id} getRtc={() => rtcRef.current?.sessionId === s.id ? rtcRef.current : null} />
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
