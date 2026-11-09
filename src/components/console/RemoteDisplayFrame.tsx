import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  computeContentRect,
  formatScale,
  validSourceSize,
  type SourceSize,
  type ViewerScaleMode,
} from "@/lib/viewer-geometry";

/**
 * Pure layout wrapper for the remote screen. The content rectangle (which
 * receives `children`: video host, fallback image, input surface, cursor
 * overlay) always has the exact source aspect ratio, so object-contain maths
 * inside it maps 1:1 with no letterbox. Only the outer viewport scrolls.
 * The DOM structure never changes between modes/metadata states, so children
 * stay mounted.
 */
export function RemoteDisplayFrame({
  source,
  mode,
  onModeChange,
  fullscreen,
  bounded = false,
  sourceLabel,
  children,
  awaiting,
}: {
  source: SourceSize | null;
  mode: ViewerScaleMode;
  onModeChange: (m: ViewerScaleMode) => void;
  fullscreen: boolean;
  /** Fit inside a parent's fixed-height flex row, including its other controls. */
  bounded?: boolean;
  sourceLabel: string;
  children: ReactNode;
  awaiting?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setAvail({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rect = computeContentRect(source, avail, mode);
  const known = !!rect;
  const scrolls = mode === "actual" && known;

  return (
    <div className={`flex min-h-0 min-w-0 flex-col ${bounded ? "shrink-0 overflow-hidden md:flex-auto" : "shrink-0"}`}>
      <div
        ref={viewportRef}
        data-testid="viewer-viewport"
        className={`relative w-full bg-black/40 min-h-[180px] shrink-0 ${bounded ? "md:min-h-0 md:flex-auto" : ""} ${scrolls ? "overflow-auto" : "overflow-hidden"}`}
        style={{ height: fullscreen ? "calc(100dvh - 12rem)" : "min(62dvh, 720px)" }}
      >
        <div
          className="flex min-h-full min-w-full"
          style={scrolls ? { width: "max-content", height: "max-content" } : { height: "100%" }}
        >
          <div
            data-testid="viewer-content-rect"
            className="relative m-auto shrink-0 overflow-hidden bg-black"
            style={
              rect
                ? { width: rect.width, height: rect.height }
                : { width: 1, height: 1, opacity: 0, pointerEvents: "none" }
            }
          >
            {children}
          </div>
        </div>
        {!known && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center">
            {awaiting ?? (
              <span className="text-sm text-white/60">Awaiting remote screen dimensions</span>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 px-3 py-1.5">
        <div
          role="group"
          aria-label="Display scale"
          className="flex rounded border border-white/15 p-0.5 text-[11px]"
        >
          {(["fit", "actual"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-testid={`button-scale-${m}`}
              onClick={() => onModeChange(m)}
              className={`rounded px-2 py-0.5 font-medium ${mode === m ? "bg-[#4F7CFF] text-white" : "text-white/70 hover:bg-white/10"}`}
              title={m === "fit" ? "Fit inside the viewer, never enlarged" : "One transmitted pixel per CSS pixel; scroll to pan"}
            >
              {m === "fit" ? "Fit" : "1:1"}
            </button>
          ))}
        </div>
        <span data-testid="text-display-geometry" className="font-mono text-[10px] text-white/60">
          {validSourceSize(source)
            ? `${sourceLabel} ${source.width}×${source.height} · ${rect ? formatScale(rect.scale) : "measuring"}${mode === "fit" && rect && rect.scale >= 1 ? " (1:1)" : ""}`
            : `${sourceLabel} · awaiting metadata`}
        </span>
      </div>
    </div>
  );
}
