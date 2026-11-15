import { useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { AGENT_LOG_PATH, describeMediaHelp, type MediaHelpInput } from "@/lib/media-help";

/**
 * "?" beside the session status line. Replaces the always-visible fallback
 * notice: the same live facts are shown in a popup only when asked for.
 */
export function MediaHelpButton({
  getContainer, ...state
}: MediaHelpInput & {
  /** The viewer panel. The popup renders inside it so fullscreen still shows it. */
  getContainer: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const help = describeMediaHelp(state);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setContainer(getContainer());
        setOpen(next);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="button-media-help"
          data-attention={help.attention ? "true" : "false"}
          aria-label={help.attention
            ? "About video and JPEG fallback. Live video is not being shown."
            : "About video and JPEG fallback"}
          title="About video and JPEG fallback"
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#4F7CFF] ${
            help.attention
              ? "border-amber-400/50 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25"
              : "border-white/20 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white"
          }`}
        >
          <span aria-hidden="true">?</span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={container ?? undefined}>
        <PopoverPrimitive.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Video and JPEG fallback"
          data-testid="jpeg-diagnostic-status"
          className="z-[60] w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-white/15 bg-[#111B2E] p-3 text-xs leading-relaxed text-white/80 shadow-2xl outline-none"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">Video and JPEG fallback</h3>
            <PopoverPrimitive.Close
              aria-label="Close"
              data-testid="button-media-help-close"
              className="-mr-1 -mt-1 rounded px-1.5 py-0.5 text-sm text-white/60 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[#4F7CFF]"
            >
              <span aria-hidden="true">×</span>
            </PopoverPrimitive.Close>
          </div>
          <p className="mt-1.5">
            The remote screen is sent as live video. If video stalls or cannot connect, the viewer
            switches to still JPEG pictures by itself and keeps retrying video. Nothing has to be
            turned on.
          </p>
          <div
            role="status"
            data-testid="media-help-now"
            className={`mt-2.5 rounded-md border px-2.5 py-2 ${
              help.attention
                ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
                : "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
            }`}
          >
            <span className="font-semibold">Right now: </span>{help.now}
          </div>
          <dl data-testid="media-recovery-status" className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {help.rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-white/50">{row.label}</dt>
                <dd className="text-white/90">{row.value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2.5 border-t border-white/10 pt-2.5">
            <div className="text-white/50">Agent logs on the remote Windows PC</div>
            <code className="mt-1 block select-all break-all rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-white/90">
              {AGENT_LOG_PATH}
            </code>
            <p className="mt-1 text-white/55">On that PC, press Win+R and paste this path.</p>
          </div>
          <p className="mt-2.5 text-white/55">
            A visible JPEG shows that capture and upload work. It does not prove that live video works.
          </p>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
