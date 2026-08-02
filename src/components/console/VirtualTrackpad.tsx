import { useEffect, useRef, useState } from "react";

export function VirtualTrackpad({
  onMove,
  onClick,
  onDoubleClick,
  onNudge,
}: {
  onMove: (dx: number, dy: number) => void;
  onClick: (button: number) => void;
  onDoubleClick: () => void;
  onNudge: (dx: number, dy: number) => void;
}) {
  const nudgeTimerRef = useRef<number | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState<number>(() => {
    if (typeof window === "undefined") return 128;
    const raw = window.localStorage.getItem("connectlive:trackpad-size");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 96 && n <= 240 ? n : 128;
  });
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("connectlive:trackpad-open") !== "0";
  });
  const [resizing, setResizing] = useState(false);
  const radius = size / 2 - 8;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem("connectlive:trackpad-pos");
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p?.x === "number" && typeof p?.y === "number") return p;
      }
    } catch {
      /* ignore */
    }
    return null;
  });
  const dragPadRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem("connectlive:trackpad-size", String(size));
    } catch {
      /* ignore */
    }
  }, [size]);
  useEffect(() => {
    try {
      window.localStorage.setItem("connectlive:trackpad-open", open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);
  useEffect(() => {
    if (!pos) return;
    try {
      window.localStorage.setItem("connectlive:trackpad-pos", JSON.stringify(pos));
    } catch {
      /* ignore */
    }
  }, [pos]);

  const clampPos = (x: number, y: number) => {
    const el = panelRef.current;
    const w = el?.offsetWidth ?? size + 24;
    const h = el?.offsetHeight ?? size + 120;
    const maxX = Math.max(0, window.innerWidth - w - 4);
    const maxY = Math.max(0, window.innerHeight - h - 4);
    return { x: Math.max(4, Math.min(maxX, x)), y: Math.max(4, Math.min(maxY, y)) };
  };
  const onPanelDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const el = panelRef.current;
    const rect = el?.getBoundingClientRect();
    const origX = pos?.x ?? rect?.left ?? 0;
    const origY = pos?.y ?? rect?.top ?? 0;
    dragPadRef.current = { startX: e.clientX, startY: e.clientY, origX, origY };
  };
  const onPanelDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragPadRef.current;
    if (!d) return;
    setPos(clampPos(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY)));
  };
  const onPanelDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragPadRef.current = null;
  };

  useEffect(() => {
    if (!dragging || !knob) return;
    const iv = setInterval(() => {
      const strength = Math.min(1, Math.hypot(knob.x, knob.y) / Math.max(1, radius));
      const maxStep = 56;
      const curve = 0.35 + strength * 0.9;
      const nx = Math.round((knob.x / Math.max(1, radius)) * maxStep * curve);
      const ny = Math.round((knob.y / Math.max(1, radius)) * maxStep * curve);
      if (nx !== 0 || ny !== 0) onMove(nx, ny);
    }, 24);
    return () => clearInterval(iv);
  }, [dragging, knob, onMove, radius]);

  function updateFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }
    setKnob({ x: dx, y: dy });
  }

  // Resize handle drag
  useEffect(() => {
    if (!resizing) return;
    const onMoveEv = (e: PointerEvent) => {
      setSize((s) => Math.max(96, Math.min(240, s - e.movementY)));
    };
    const onUp = () => setResizing(false);
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizing]);

  const knobSize = Math.max(20, Math.round(size * 0.24));

  // Press-and-hold cursor nudge. First tick fires immediately, then a
  // 24ms interval keeps sending the same delta with a mild acceleration
  // curve while the pointer stays down.
  const startNudge = (dx: number, dy: number) => {
    if (nudgeTimerRef.current != null) window.clearInterval(nudgeTimerRef.current);
    onNudge(dx, dy);
    let ticks = 0;
    nudgeTimerRef.current = window.setInterval(() => {
      ticks += 1;
      const accel = Math.min(4, 1 + ticks * 0.15);
      onNudge(Math.round(dx * accel), Math.round(dy * accel));
    }, 24);
  };
  const stopNudge = () => {
    if (nudgeTimerRef.current != null) {
      window.clearInterval(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
  };
  const hideTrackpad = () => {
    stopNudge();
    dragPadRef.current = null;
    setDragging(false);
    setKnob(null);
    setResizing(false);
    setOpen(false);
  };
  useEffect(
    () => () => {
      if (nudgeTimerRef.current != null) {
        window.clearInterval(nudgeTimerRef.current);
        nudgeTimerRef.current = null;
      }
    },
    [],
  );

  // Hidden state: only render a small pull-tab so the panel is off the way.
  // NOTE: all hooks MUST be declared above this early return.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-0 z-10 flex items-center gap-1 rounded-l-md border border-r-0 border-white/15 bg-black/70 px-2 py-3 text-[10px] uppercase tracking-widest text-white/70 hover:bg-black/90"
        aria-label="Show trackpad"
      >
        <span>‹</span>
        <span className="[writing-mode:vertical-rl] rotate-180">Pad</span>
      </button>
    );
  }

  const NudgeBtn = ({
    label,
    dx,
    dy,
    ariaLabel,
  }: {
    label: string;
    dx: number;
    dy: number;
    ariaLabel: string;
  }) => (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        startNudge(dx, dy);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        stopNudge();
      }}
      onPointerLeave={stopNudge}
      onPointerCancel={stopNudge}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="rounded bg-white/10 px-2 py-1 text-xs leading-4 hover:bg-white/20 active:bg-white/25"
    >
      {label}
    </button>
  );

  return (
    <div
      ref={panelRef}
      className={`${pos ? "fixed" : "absolute bottom-4 right-4"} z-20 flex select-none flex-col items-center gap-2 rounded-xl border border-white/10 bg-black/70 p-3 backdrop-blur-md`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div
        className="flex w-full cursor-grab items-center justify-between gap-3 active:cursor-grabbing"
        onPointerDown={onPanelDragStart}
        onPointerMove={onPanelDragMove}
        onPointerUp={onPanelDragEnd}
        onPointerCancel={onPanelDragEnd}
        title="Drag to move"
      >
        <span className="text-[10px] uppercase tracking-widest text-white/50">⋮⋮ Trackpad</span>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => setSize((s) => Math.max(96, s - 16))}
            className="rounded bg-white/10 px-1.5 text-xs leading-4 hover:bg-white/20"
            aria-label="Shrink trackpad"
          >
            −
          </button>
          <button
            onClick={() => setSize((s) => Math.min(240, s + 16))}
            className="rounded bg-white/10 px-1.5 text-xs leading-4 hover:bg-white/20"
            aria-label="Grow trackpad"
          >
            +
          </button>
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              hideTrackpad();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              hideTrackpad();
            }}
            className="rounded bg-white/10 px-1.5 text-xs leading-4 hover:bg-white/20"
            aria-label="Hide trackpad"
            title="Hide"
          >
            ✕
          </button>
        </div>
      </div>
      <div
        className="relative rounded-full border border-white/15 bg-white/5"
        style={{ width: size, height: size }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          updateFromPointer(e);
        }}
        onPointerMove={(e) => {
          if (dragging) updateFromPointer(e);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
          setKnob(null);
        }}
        onPointerCancel={() => {
          setDragging(false);
          setKnob(null);
        }}
      >
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 rounded-full bg-[#4F7CFF] shadow-lg transition-transform"
          style={{
            width: knobSize,
            height: knobSize,
            transform: `translate(calc(-50% + ${knob?.x ?? 0}px), calc(-50% + ${knob?.y ?? 0}px))`,
          }}
        />
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            setResizing(true);
          }}
          className="absolute -left-1 -bottom-1 h-4 w-4 cursor-nwse-resize rounded-full border border-white/30 bg-white/10 hover:bg-white/20"
          title="Drag up/down to resize"
        />
      </div>
      {/* Click row — glyphs so it doesn't read as "direction" next to the knob */}
      <div className="flex gap-2">
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            onClick(0);
          }}
          title="Left click"
          aria-label="Left click"
          className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
        >
          ◧
        </button>
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            onDoubleClick();
          }}
          title="Double click (open)"
          aria-label="Double click"
          className="rounded bg-[#4F7CFF]/80 px-3 py-1 text-xs text-white hover:bg-[#4F7CFF]"
        >
          ◉
        </button>
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            onClick(2);
          }}
          title="Right click"
          aria-label="Right click"
          className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
        >
          ◨
        </button>
      </div>
      {/* Directional pad — nudges the mouse cursor on the remote (hold to glide) */}
      <div className="grid grid-cols-3 gap-1 pt-1">
        <span />
        <NudgeBtn label="▲" dx={0} dy={-12} ariaLabel="Nudge cursor up" />
        <span />
        <NudgeBtn label="◀" dx={-12} dy={0} ariaLabel="Nudge cursor left" />
        <span />
        <NudgeBtn label="▶" dx={12} dy={0} ariaLabel="Nudge cursor right" />
        <span />
        <NudgeBtn label="▼" dx={0} dy={12} ariaLabel="Nudge cursor down" />
        <span />
      </div>
    </div>
  );
}
