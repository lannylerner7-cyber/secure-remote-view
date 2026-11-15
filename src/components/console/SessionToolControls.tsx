import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EMPTY_SESSION_TOOLS, type MicrophonePhase, type SessionToolsClient, type SessionToolsState,
  type SetupRequirement, type VerificationPhase, type VerificationSetup,
} from "@/shared/session-tools";

type Scenario = "autofill" | "saved_passwords" | "passkey";
function errorText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

const MIC_TEXT: Record<MicrophonePhase, string> = {
  off: "Off. Listening is never started automatically.",
  requesting: "Requested. Waiting for the Agent to confirm…",
  sharing: "Listening. The Agent confirmed microphone audio is being shared.",
  locally_stopped: "Stopped on the device by the user.",
  permission_denied: "Owner consent or Windows microphone permission was denied.",
  device_unavailable: "No usable microphone. Check the default communications microphone in Windows; unknown or line-level inputs are not shared.",
  transport_failure: "Audio transport failed. Microphone state is not confirmed as sharing.",
};
const VERIFY_TEXT: Record<VerificationPhase, string> = {
  idle: "Not started.",
  unsupported: "Saved-PIN assistance is unsupported. Approve on the Windows device.",
  approval_required: "Waiting for the person at the Windows device to approve.",
  in_progress: "The person at the device is completing the verification prompt.",
  cancelled: "Request cancelled. ConnectLive did not submit a credential; the application result is unconfirmed.",
  result_unconfirmed: "On-device step closed. The application's authentication result is unconfirmed.",
};
const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: "autofill", label: "Browser autofill", hint: "Windows Hello prompt before the browser fills a saved entry." },
  { id: "saved_passwords", label: "Saved passwords", hint: "Windows Hello prompt to reveal or manage saved passwords." },
  { id: "passkey", label: "Passkey", hint: "Windows Hello prompt for a site or app passkey." },
];
const SETUP_LABELS: [keyof VerificationSetup, string][] = [
  ["localApproval", "Local approval"], ["helperInstallation", "Helper installed"],
  ["protectedIdentity", "Protected identity"], ["encryptionEnrollment", "Encryption enrollment"],
  ["savedCredential", "Saved PIN"], ["connectivity", "Connectivity"],
];
const REQ_TEXT: Record<SetupRequirement, string> = { ready: "Ready", required: "Required", unavailable: "Unavailable", unconfirmed: "Unconfirmed" };
const REQ_TONE: Record<SetupRequirement, string> = { ready: "text-emerald-300", required: "text-amber-200", unavailable: "text-rose-300", unconfirmed: "text-white/50" };

/** Microphone and on-device app/browser verification. Separate from Unlock Windows. */
export function SessionToolControls({ tools, allowed, protectedMedia, onBeginVerification, section = "all" }: {
  tools: SessionToolsClient | null; allowed: boolean; protectedMedia: boolean;
  onBeginVerification: () => Promise<void>;
  section?: "all" | "microphone" | "verification";
}) {
  const [state, setState] = useState<SessionToolsState>(EMPTY_SESSION_TOOLS);
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const version = useRef(0);
  const micVersion = useRef(0);
  const beginRef = useRef(onBeginVerification);
  beginRef.current = onBeginVerification;

  useEffect(() => {
    version.current++;
    micVersion.current++;
    setMicBusy(false); setMicError(null); setScenario(null); setConfirmed(false);
    setStarting(false); setVerifyError(null); setRefreshing(false);
    if (!tools) { setState(EMPTY_SESSION_TOOLS); return; }
    setState(tools.state());
    const off = tools.onState((s) => {
      setState(s);
      if (s.verification !== "idle" && s.verification !== "approval_required" && s.verification !== "in_progress") setConfirmed(false);
    });
    return () => {
      version.current++;
      off();
      const v = tools.state().verification;
      if (section !== "microphone" && (v === "approval_required" || v === "in_progress")) tools.cancelVerification();
    };
  }, [tools, section]);

  async function setMic(listen: boolean) {
    const t = toolsRef.current;
    if (!t || (micBusy && listen)) return;
    const v = ++micVersion.current;
    setMicBusy(true); setMicError(null);
    try { await t.microphone(listen); }
    catch (e) { if (micVersion.current === v) setMicError(errorText(e, listen ? "Listening was not confirmed." : "Off was not confirmed. Check the device.")); }
    finally { if (micVersion.current === v) setMicBusy(false); }
  }

  async function approve() {
    const t = toolsRef.current;
    if (!t || !scenario || !confirmed || starting) return;
    const v = ++version.current;
    setStarting(true); setVerifyError(null);
    try {
      await beginRef.current();
      if (version.current !== v || toolsRef.current !== t) return;
      await t.verifyOnDevice(scenario);
    } catch (e) {
      if (version.current === v) setVerifyError(errorText(e, "On-device verification did not start. No retry was made."));
    } finally {
      if (version.current === v) { setStarting(false); setConfirmed(false); }
    }
  }

  async function refresh() {
    const t = toolsRef.current;
    if (!t) return;
    const v = version.current;
    setRefreshing(true);
    try { await t.refresh(); }
    catch (e) { if (version.current === v) setVerifyError(errorText(e, "Status refresh failed.")); }
    finally { if (version.current === v) setRefreshing(false); }
  }

  const mic = state.microphone;
  const vphase = state.verification;
  const verifying = starting || vphase === "approval_required" || vphase === "in_progress";
  const setup = state.setup;
  const box = "space-y-2 rounded-lg border border-white/10 bg-[#0B1220] p-3 text-sm text-white";
  const outline = "border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white";

  let blocker: string | null = null;
  if (!allowed) blocker = "Your account does not have permission to use session tools on this device.";
  else if (!tools) blocker = "Session tools need a live session with the Agent.";
  else if (!state.supported) blocker = state.reason ?? "This Agent does not support session tools.";

  let micBlocker: string | null = blocker;
  if (!micBlocker && !state.microphoneAllowed) micBlocker = "The device owner has not allowed microphone listening.";
  const listenBlocked = !!micBlocker || protectedMedia || micBusy || mic === "sharing" || mic === "requesting";
  const offAvailable = !!tools && mic !== "off";

  const verifyBlocker = blocker ?? (vphase === "unsupported" ? VERIFY_TEXT.unsupported : null);

  return (
    <div className="space-y-3">
      {section !== "verification" && <section aria-label="Microphone" data-testid="panel-microphone" className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">Device microphone</span>
          <div className="flex gap-2">
            <Button type="button" size="sm" data-testid="button-mic-listen" disabled={listenBlocked}
              onClick={() => void setMic(true)} className="bg-[#4F7CFF] text-white hover:bg-[#4F7CFF]/90">
              <Mic className="h-3.5 w-3.5" /> Listen
            </Button>
            <Button type="button" size="sm" variant="outline" data-testid="button-mic-off" disabled={!offAvailable}
              onClick={() => void setMic(false)} className={outline}>
              <MicOff className="h-3.5 w-3.5" /> Off
            </Button>
          </div>
        </div>
        <p role="status" aria-live="polite" data-testid="status-microphone"
          className={`text-xs ${mic === "sharing" ? "text-emerald-300" : mic === "off" || mic === "requesting" ? "text-white/70" : "text-rose-300"}`}>
          {micBusy && mic !== "requesting" ? "Waiting for the Agent's receipt…" : MIC_TEXT[mic]}
        </p>
        {micBlocker && <p className="text-[11px] text-white/50">{micBlocker}</p>}
        {!state.microphoneAllowed && <details className="text-[11px] text-white/60">
          <summary>Owner setup on the Windows device</summary>
          <p className="mt-1">The owner can run <code>ConnectLive.exe --session-tools-setup</code> to choose microphone consent and approved folders, or skip both. Old view/control consent does not grant microphone access.</p>
        </details>}
        {protectedMedia && !micBlocker && <p className="text-[11px] text-amber-200">Listening is paused while protected content is on screen. Off stays available.</p>}
        {micError && <p role="alert" className="text-xs text-rose-300">{micError}</p>}
      </section>}

      {section !== "microphone" && <section aria-label="App and browser verification" data-testid="panel-app-verification" className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/50">
            <ShieldCheck className="h-3.5 w-3.5" /> App &amp; browser verification
          </span>
          <Button type="button" size="sm" variant="ghost" data-testid="button-refresh-tools" disabled={!tools || refreshing}
            onClick={() => void refresh()} className="text-white/70 hover:bg-white/5 hover:text-white">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> {refreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
        <p className="text-[11px] text-white/50">
          Not Unlock Windows. This asks the person at the device to complete a Windows Hello prompt for an app or browser.
          There is no supported way to use a saved PIN here; verification happens only on the device.
        </p>

        {setup && (
          <div data-testid="list-verification-setup" className="rounded border border-white/10 p-2">
            <p className="mb-1 text-[11px] font-semibold text-white/60">Setup requirements</p>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2">
              {SETUP_LABELS.map(([k, label]) => {
                const val = setup[k] as SetupRequirement;
                return (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="text-white/50">{label}</dt>
                    <dd data-testid={`status-setup-${k}`} className={REQ_TONE[val]}>{REQ_TEXT[val]}</dd>
                  </div>
                );
              })}
              <div className="flex justify-between gap-2">
                <dt className="text-white/50">Lock screen</dt>
                <dd className="text-white/60">{setup.lockScreen === "available" ? "Available" : setup.lockScreen === "not_locked" ? "Not locked" : "Unavailable"}</dd>
              </div>
            </dl>
            <p className="mt-1 text-[11px] text-white/40">Saving a PIN does not validate it with Windows. It is used for Unlock Windows only; app verification remains on-device only.</p>
          </div>
        )}
        <details className="text-[11px] text-white/60">
          <summary>Optional PIN setup</summary>
          <p className="mt-1">On the Windows device, run <code>ConnectLive.exe --session-tools-setup</code>. The owner may enroll or replace a PIN, or skip setup. Source-run installations cannot install or impersonate the trusted unlock helper. Forget or revoke existing access in Windows PIN settings.</p>
        </details>

        <p role="status" aria-live="polite" data-testid="status-verification"
          className={`text-xs ${vphase === "cancelled" || vphase === "unsupported" ? "text-rose-300" : "text-white/70"}`}>
          {starting && vphase === "idle" ? "Preparing the request…" : VERIFY_TEXT[vphase]}
          {state.reason && (vphase === "cancelled" || vphase === "unsupported") ? ` ${state.reason}` : ""}
        </p>
        {vphase !== "idle" && <p className="text-[11px] text-white/50">Input and recording do not resume automatically. After verification, reload the live viewer before explicitly starting a new recording.</p>}
        {state.requestId && verifying && <p className="text-[11px] text-white/40" data-testid="text-verification-request">Request {state.requestId}</p>}

        {verifyBlocker ? (
          <p className="text-[11px] text-white/50">{verifyBlocker}</p>
        ) : verifying ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" data-testid="button-cancel-verification" className={outline}
              onClick={() => { version.current++; setStarting(false); toolsRef.current?.cancelVerification(); }}>Cancel</Button>
            {(vphase === "in_progress" || vphase === "approval_required") && (
              <Button type="button" size="sm" variant="outline" data-testid="button-finish-verification" className={outline}
                onClick={() => toolsRef.current?.finishVerification()}>Finish on-device step</Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <fieldset className="space-y-1">
              <legend className="mb-1 text-[11px] text-white/60">What does the person need to verify?</legend>
              {SCENARIOS.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-xs hover:bg-white/5">
                  <input type="radio" name="verify-scenario" value={s.id} data-testid={`radio-scenario-${s.id}`}
                    checked={scenario === s.id} onChange={() => { setScenario(s.id); setConfirmed(false); }}
                    className="mt-0.5 accent-[#4F7CFF]" />
                  <span><span className="text-white/85">{s.label}</span><span className="block text-white/45">{s.hint}</span></span>
                </label>
              ))}
            </fieldset>
            {scenario && (
              <label className="flex items-start gap-2 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
                <input type="checkbox" data-testid="checkbox-confirm-verification" checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 accent-[#4F7CFF]" />
                <span>The person at the device has asked for this, and will approve and complete the prompt themselves. This confirmation covers this request only.</span>
              </label>
            )}
            <Button type="button" size="sm" data-testid="button-approve-on-device" disabled={!scenario || !confirmed || starting}
              onClick={() => void approve()} className="bg-[#4F7CFF] text-white hover:bg-[#4F7CFF]/90">
              {starting ? "Starting…" : "Approve on Windows device"}
            </Button>
          </div>
        )}
        {verifyError && <p role="alert" data-testid="text-verification-error" className="text-xs text-rose-300">{verifyError}</p>}
      </section>}
    </div>
  );
}
