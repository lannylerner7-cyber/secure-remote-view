import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WebRtcLive, WebRtcState } from "@/lib/webrtc-live";
import { getWindowsUnlock, requestWindowsUnlock } from "@/lib/windows-unlock-client";
import { EMPTY_UNLOCK, type UnlockDevice, type UnlockState, type UnlockTicket } from "@/shared/windows-unlock";

/** Members the transport adds for secure lock-screen input. */
type UnlockLive = WebRtcLive & {
  peerId: () => string | null;
  unlockState: () => UnlockState;
  onUnlock: (cb: (s: UnlockState) => void) => () => void;
  beginUnlock: (ticket: UnlockTicket) => Promise<void>;
  useSavedUnlockPin: () => void;
  cancelUnlock: () => void;
};

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

const PHASE_TEXT: Record<UnlockState["phase"], string> = {
  idle: "Not active",
  starting: "Preparing the secure Windows sign-in screen…",
  ready: "Secure sign-in screen ready. Input goes only to the Windows sign-in screen.",
  submitted: "PIN use requested. Waiting for Windows to confirm sign-in…",
  unlocked: "Last attempt: Windows reported unlocked. Returned to view-only.",
  cancelled: "Unlock cancelled. Back to view-only.",
  blocked: "Windows unlock is blocked.",
};

/**
 * Explicit, operator-initiated lock-screen unlock. Never retries, never
 * auto-resumes after reconnect, and only reports success when Windows does.
 */
export function WindowsUnlockControls({
  deviceId, sessionId, live, canUnlock, beforeStart,
}: {
  deviceId: string; sessionId: string; live: WebRtcLive | null; canUnlock: boolean;
  beforeStart: () => Promise<void>;
}) {
  const ul = live as UnlockLive | null;
  const [status, setStatus] = useState<UnlockDevice | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [unlock, setUnlock] = useState<UnlockState>(EMPTY_UNLOCK);
  const [channel, setChannel] = useState<WebRtcState>("idle");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPin, setConfirmPin] = useState(false);
  const [pinUsedFor, setPinUsedFor] = useState<string | null>(null);
  const context = `${deviceId}:${sessionId}`;
  const deviceRef = useRef(context);
  deviceRef.current = context;
  const liveRef = useRef(live);
  liveRef.current = live;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const startLock = useRef(false);
  const startVersion = useRef(0);
  const allowedRef = useRef(canUnlock);
  allowedRef.current = canUnlock;
  const beforeStartRef = useRef(beforeStart);
  beforeStartRef.current = beforeStart;

  const refresh = useCallback(async () => {
    const id = deviceId, owner = context;
    try {
      const row = await getWindowsUnlock(id);
      if (!mounted.current || deviceRef.current !== owner || row?.deviceId !== id) return;
      setStatus(row);
      setStatusError(null);
    } catch (e) {
      if (!mounted.current || deviceRef.current !== owner) return;
      setStatus(null);
      setStatusError(errorText(e, "Windows unlock status is unavailable."));
    }
  }, [deviceId, context]);

  useEffect(() => {
    setStatus(null); setStatusError(null); setError(null); setConfirmPin(false); setPinUsedFor(null);
    void refresh();
    const iv = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(iv);
  }, [refresh]);

  useEffect(() => {
    if (!ul) { setUnlock(EMPTY_UNLOCK); setChannel("idle"); return; }
    setChannel(ul.state());
    const offState = ul.onState(setChannel);
    let offUnlock: (() => void) | undefined;
    if (typeof ul.unlockState === "function" && typeof ul.onUnlock === "function") {
      setUnlock(ul.unlockState());
      offUnlock = ul.onUnlock((s) => { setUnlock(s); if (s.phase !== "ready") setConfirmPin(false); });
    }
    return () => { ul.cancelUnlock?.(); offState(); offUnlock?.(); };
  }, [ul]);

  const supported = !!ul && typeof ul.beginUnlock === "function";
  const phase = unlock.phase;
  const active = starting || phase === "starting" || phase === "ready" || phase === "submitted";
  const connected = channel === "connected";

  let blocker: string | null = null;
  if (!canUnlock) blocker = "Your account does not have permission to unlock this device.";
  else if (!supported) blocker = "This console connection does not support secure lock-screen input.";
  else if (!connected) blocker = "Connect a live session first. Unlock never resumes automatically after reconnect.";
  else if (statusError) blocker = statusError;
  else if (!status) blocker = "Checking current Windows lock state…";
  else if (status && !status.enabled) blocker = "Lock-screen access is not enabled. Run the Agent with --unlock-setup on the device.";
  else if (status && !status.helperReady) blocker = "The local unlock service is not running, or the Agent is offline or too old.";
  else if (status && status.locked === false) blocker = "Windows reports this device is not locked.";
  else if (status && status.locked !== true) blocker = "Windows lock state is unknown. Unlock is unavailable.";

  async function start() {
    if (!ul || blocker || startLock.current || active) return;
    startLock.current = true;
    const id = deviceId, owner = context;
    const version = ++startVersion.current;
    const current = () => mounted.current && startVersion.current === version && allowedRef.current &&
      deviceRef.current === owner && liveRef.current === ul;
    setStarting(true); setError(null); setConfirmPin(false); setPinUsedFor(null);
    try {
      ul.prepareUnlock();
      await beforeStartRef.current();
      if (!current()) return;
      const peer = ul.peerId();
      if (!peer) throw new Error("The live session has no ready peer. Reconnect, then try again.");
      const ticket = await requestWindowsUnlock(id, sessionId, peer);
      if (!current()) return;
      await ul.beginUnlock(ticket);
    } catch (e) {
      if (current()) setError(errorText(e, "Secure unlock could not start. No automatic retry was made."));
    } finally {
      if (startVersion.current === version) {
        startLock.current = false;
        if (mounted.current) setStarting(false);
      }
    }
  }

  function submitSavedPin() {
    if (!ul || phase !== "ready" || !status?.hasPin) return;
    const rid = unlock.requestId ?? "";
    if (pinUsedFor === rid) return;
    setPinUsedFor(rid);
    setConfirmPin(false);
    try { ul.useSavedUnlockPin(); }
    catch (e) { setError(errorText(e, "PIN submission was not confirmed. No retry was made.")); }
  }

  const tone = phase === "unlocked" ? "text-emerald-300" : phase === "blocked" ? "text-rose-300" : "text-white/70";

  return (
    <section aria-label="Windows lock-screen unlock" data-testid="panel-windows-unlock" className="space-y-2 rounded-lg border border-white/10 bg-[#0B1220] p-3 text-sm text-white">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">Windows sign-in</span>
        {active ? (
          <Button type="button" size="sm" variant="outline" data-testid="button-cancel-unlock" onClick={() => {
            startVersion.current++; startLock.current = false; setStarting(false);
            ul?.cancelUnlock(); setError("Unlock cancelled. No PIN was retried.");
          }}>
            Cancel unlock
          </Button>
        ) : (
          <Button type="button" size="sm" data-testid="button-unlock-windows" disabled={!!blocker || starting}
            onClick={() => void start()} className="bg-[#4F7CFF] text-white hover:bg-[#4F7CFF]/90">
            {starting ? "Starting..." : "Unlock Windows"}
          </Button>
        )}
      </div>

      <p role="status" aria-live="polite" data-testid="status-unlock-phase" className={`text-xs ${tone}`}>
        {phase === "idle" ? (blocker ?? "Available. Starts only when you click Unlock Windows.") : PHASE_TEXT[phase]}
        {phase === "blocked" && unlock.reason ? ` ${unlock.reason}` : ""}
        {phase === "cancelled" && unlock.reason ? ` ${unlock.reason}` : ""}
      </p>
      {phase !== "idle" && blocker && !active && <p className="text-[11px] text-white/50">{blocker}</p>}
      {!active && phase !== "idle" && (
        <p className="text-[11px] text-white/50">Take control explicitly to resume ordinary input. Close and reopen the viewer before recording again, so secure-screen buffers cannot enter a recording.</p>
      )}
      {statusError && status && <p className="text-[11px] text-amber-200">Status refresh failed: {statusError}</p>}
      {status && status.locked === null && !blocker && <p className="text-[11px] text-white/50">Lock state is unknown; the Agent may be offline.</p>}

      {phase === "ready" && (
        <div className="space-y-2 border-t border-white/10 pt-2 text-xs text-white/70">
          <p>Type on the remote screen to enter the PIN manually. The secure screen is not the privacy curtain.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => {
            if (!ul?.sendUnlockSas()) setError("Secure attention was not requested. Use the visible sign-in screen.");
          }}>Send Ctrl+Alt+Delete</Button>
          {status?.hasPin && pinUsedFor !== (unlock.requestId ?? "") && (confirmPin ? (
            <div className="space-y-2 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-amber-100">
              <p>Confirm you have selected the correct Windows account and an empty Windows Hello PIN field on the visible sign-in screen. The saved PIN is sent once, with no retry.</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" data-testid="button-confirm-saved-pin" onClick={submitSavedPin}>Use saved PIN once</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmPin(false)}>Back</Button>
              </div>
            </div>
          ) : (
            <Button type="button" size="sm" variant="outline" data-testid="button-use-saved-pin" onClick={() => setConfirmPin(true)}>
              Use saved PIN
            </Button>
          ))}
        </div>
      )}

      {error && <p role="alert" data-testid="text-unlock-start-error" className="text-xs text-rose-300">{error}</p>}
    </section>
  );
}
