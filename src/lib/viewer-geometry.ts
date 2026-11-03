export type SourceSize = { width: number; height: number };
export type ViewerScaleMode = "fit" | "actual";

export function validSourceSize(source: SourceSize | null): source is SourceSize {
  return !!source && Number.isFinite(source.width) && Number.isFinite(source.height)
    && source.width > 0 && source.height > 0;
}

/**
 * Size of the content rectangle for a remote source.
 * - fit: preserves the exact source aspect, scales DOWN only (never above 1).
 * - actual: one transmitted pixel per CSS pixel (scale 1); the enclosing
 *   viewport scrolls.
 * Returns null when the source size is unknown — callers must not invent one.
 */
export function computeContentRect(
  source: SourceSize | null,
  avail: { width: number; height: number },
  mode: ViewerScaleMode,
): { width: number; height: number; scale: number } | null {
  if (!validSourceSize(source)) return null;
  if (mode === "actual") return { width: source.width, height: source.height, scale: 1 };
  if (!validSourceSize(avail)) return null;
  const scale = Math.min(1, avail.width / source.width, avail.height / source.height);
  return {
    // CSS supports fractional pixels. Rounding each axis independently would
    // subtly change the source aspect ratio, especially on portrait displays.
    width: source.width * scale,
    height: source.height * scale,
    scale,
  };
}

export function formatScale(scale: number): string {
  return `${Math.round(scale * 1000) / 10}%`;
}
