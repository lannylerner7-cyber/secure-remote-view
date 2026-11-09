import { useEffect, useState } from "react";
import type { WebRtcLive } from "@/lib/webrtc-live";
import type { LiveDiagnostics } from "@/lib/live-diagnostics";

export function LiveConnectionDiagnostics({ live, agentVersion }: {
  live: WebRtcLive | null; agentVersion?: unknown;
}) {
  const [snapshot, setSnapshot] = useState<LiveDiagnostics | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  useEffect(() => {
    setCopyNotice("");
    const sample = () => setSnapshot(live?.diagnostics?.() ?? null);
    sample();
    const timer = window.setInterval(sample, 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const version = typeof agentVersion === "string" && /^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(agentVersion)
    ? agentVersion.slice(0, 32) : "unreported";
  const number = (value: number | null | undefined, suffix = "") =>
    value == null ? "Not measured" : `${value}${suffix}`;
  return (
    <details className="max-w-xs rounded border border-white/10 px-3 py-1.5 text-xs" data-testid="live-connection-diagnostics">
      <summary className="cursor-pointer">Connection diagnostics</summary>
      {!snapshot ? <p className="mt-2 text-white/60">No active peer. Reconnect the viewer to start a fresh attempt.</p> :
        <dl className="mt-2 space-y-1 break-words text-white/60">
          <dt>Versions</dt><dd className="text-white">Agent {version}; viewer protocol {snapshot.viewerProtocol}; gateway protocol {snapshot.serverProtocol ?? "unreported"}</dd>
          <dt>Connection / ICE / signaling</dt><dd className="text-white">{snapshot.connection} / {snapshot.ice} / {snapshot.signaling}</dd>
          <dt>Command / files / clipboard channels</dt><dd className="text-white">{snapshot.inputChannel} / {snapshot.filesChannel} / {snapshot.clipboardChannel}</dd>
          <dt>TURN configuration</dt><dd className="text-white">{snapshot.provider}; {snapshot.relayConfigured ? "available, not proof of relay use" : "no relay configured"}</dd>
          <dt>Selected path</dt><dd className="text-white">{snapshot.relayed == null ? "Not selected" : snapshot.relayed ? "Relayed" : "Direct"} · {snapshot.localCandidate ?? "?"} / {snapshot.remoteCandidate ?? "?"} · {snapshot.transport ?? "?"}</dd>
          <dt>RTT / jitter / packets lost</dt><dd className="text-white">{number(snapshot.roundTripMs, " ms")} / {number(snapshot.jitterMs, " ms")} / {snapshot.packetsLost}</dd>
          <dt>Codec / received bytes</dt><dd className="text-white">{snapshot.codec ?? "Not negotiated"} / {snapshot.bytesReceived}</dd>
          <dt>Decoded / presented / dropped frames</dt><dd className="text-white">{snapshot.framesDecoded} / {number(snapshot.presentedFrames)} / {snapshot.framesDropped}</dd>
          <dt>Last decoded / presented frame age</dt><dd className="text-white">{number(snapshot.lastDecodedAgeMs, " ms")} / {number(snapshot.lastPresentedAgeMs, " ms")}</dd>
          <dt>Signals applied / catch-up</dt><dd className="text-white">{snapshot.signalsApplied} / {snapshot.catchup} ({number(snapshot.catchupMs, " ms")})</dd>
        </dl>}
      <p className="mt-2 text-[10px] text-white/50">Configuration, connectivity, decoding and presentation are separate checks. No addresses, credentials or screen contents are included.</p>
      <button type="button" className="mt-2 rounded border border-white/20 px-2 py-1 text-white disabled:opacity-50"
        disabled={!snapshot}
        onClick={async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error("unavailable");
            await navigator.clipboard.writeText(JSON.stringify({
              capturedAt: new Date().toISOString(), viewerOrigin: window.location.origin,
              agentVersion: version, ...snapshot,
            }, null, 2));
            setCopyNotice("Sanitized diagnostics copied.");
          } catch { setCopyNotice("Clipboard access is unavailable. Read the diagnostics above."); }
        }}>Copy diagnostics</button>
      <p role="status" className="mt-1 text-[10px] text-white/60">{copyNotice}</p>
    </details>
  );
}
