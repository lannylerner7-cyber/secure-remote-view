import type { InputIndicatorTone } from "./session-tools";

const TONE: Record<InputIndicatorTone, string> = {
  neutral: "border-white/15 bg-white/5 text-white/75",
  ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  pending: "border-[#4F7CFF]/40 bg-[#4F7CFF]/10 text-[#B9CCFF]",
  paused: "border-amber-400/40 bg-amber-400/10 text-amber-100",
  warn: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  secure: "border-sky-300/40 bg-sky-300/10 text-sky-100",
};

/** Always-visible session state, independent of the selected tool. */
export function SessionStatusStrip({
  input, curtain, recording, transfer, connection,
}: {
  input: { label: string; tone: InputIndicatorTone; detail: string };
  curtain: string | null;
  recording: boolean;
  transfer: boolean;
  connection: { label: string; ok: boolean };
}) {
  return (
    <div role="status" aria-live="polite" data-testid="session-status-strip"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/10 bg-[#0B1220] px-3 py-1.5 text-[10px]">
      <span data-testid="status-remote-input" title={input.detail}
        className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium ${TONE[input.tone]}`}>
        <span className={`h-1.5 w-1.5 rounded-full bg-current ${input.tone === "pending" ? "animate-pulse" : ""}`} />
        {input.label}
      </span>
      <span className="hidden text-white/55 sm:inline">{input.detail}</span>
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {curtain && <span data-testid="status-curtain" className="rounded-full border border-white/15 px-2 py-0.5 text-white/70">{curtain}</span>}
        {recording && (
          <span data-testid="status-recording" className="flex items-center gap-1 rounded-full border border-red-400/40 bg-red-500/10 px-2 py-0.5 text-red-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />Recording
          </span>
        )}
        {transfer && <span data-testid="status-transfer" className="rounded-full border border-white/15 px-2 py-0.5 text-white/70">File transfer active</span>}
        <span data-testid="status-connection" className={`rounded-full border px-2 py-0.5 ${connection.ok ? "border-emerald-400/30 text-emerald-200" : "border-amber-400/30 text-amber-100"}`}>
          {connection.label}
        </span>
      </span>
    </div>
  );
}
