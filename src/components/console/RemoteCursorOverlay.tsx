import { useEffect, useRef, useState } from "react";
import type { LiveCursor, LiveFrame } from "@/lib/console-types";

/**
 * SVG overlay rendering the remote cursor position independently from
 * JPEG frames (Phase-1 upgrade). Uses ResizeObserver + object-contain
 * math so the pointer lands where it truly is on the remote screen,
 * even when the container is letterboxed.
 */
export function RemoteCursorOverlay({ cursor, frame }: { cursor: LiveCursor; frame: LiveFrame | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fw = cursor.frame_w ?? frame?.width ?? 0;
  const fh = cursor.frame_h ?? frame?.height ?? 0;
  if (!fw || !fh || !box.w || !box.h)
    return <div ref={ref} className="pointer-events-none absolute inset-0" />;
  const scale = Math.min(box.w / fw, box.h / fh);
  const drawW = fw * scale,
    drawH = fh * scale;
  const offX = (box.w - drawW) / 2,
    offY = (box.h - drawH) / 2;
  const px = offX + cursor.x * scale;
  const py = offY + cursor.y * scale;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      <svg
        width="20"
        height="24"
        viewBox="0 0 20 24"
        style={{
          position: "absolute",
          left: px,
          top: py,
          transform: "translate(-2px,-2px)",
          cursor: cursor.kind,
          filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.6))",
        }}
      >
        <path
          d="M1 1 L1 19 L6 14 L9 22 L12 21 L9 13 L16 13 Z"
          fill="#fff"
          stroke="#000"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
